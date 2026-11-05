const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const express = require('express');
const session = require('express-session');
const { openDatabase, localDateTime, isFuture, SEAT_COUNT, DEFAULT_TIME_ZONE } = require('./database');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const positiveId = value => Number.isSafeInteger(value) && value > 0;
function routeId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !positiveId(Number(value))) fail(400, 'Некорректный идентификатор.');
  return Number(value);
}
function objectBody(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) fail(400, 'Тело запроса должно быть JSON-объектом.');
  return req.body;
}
function text(value, label, min, max, multiline = false) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(multiline ? value.replace(/[\r\n]/g, '') : value)) {
    fail(400, `${label}: введите от ${min} до ${max} символов без управляющих знаков.`);
  }
  return value.trim();
}
function sameSecret(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

class SQLiteSessionStore extends session.Store {
  constructor(db) { super(); this.db = db; }
  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT data FROM admin_sessions WHERE sid = ? AND expires > ?').get(sid, Date.now());
      callback(null, row ? JSON.parse(row.data) : null);
    } catch (error) { callback(error); }
  }
  set(sid, data, callback = () => {}) {
    try {
      const expires = data.cookie.expires ? new Date(data.cookie.expires).getTime() : Date.now() + 3600000;
      this.db.prepare('INSERT INTO admin_sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data, expires=excluded.expires').run(sid, JSON.stringify(data), expires);
      this.db.prepare('DELETE FROM admin_sessions WHERE expires <= ?').run(Date.now());
      callback(null);
    } catch (error) { callback(error); }
  }
  destroy(sid, callback = () => {}) {
    try { this.db.prepare('DELETE FROM admin_sessions WHERE sid = ?').run(sid); callback(null); }
    catch (error) { callback(error); }
  }
  touch(sid, data, callback = () => {}) { this.set(sid, data, callback); }
}

function createApp(options = {}) {
  const adminLogin = options.adminLogin ?? process.env.ADMIN_LOGIN;
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD;
  const sessionSecret = options.sessionSecret ?? process.env.SESSION_SECRET;
  if (!adminLogin || !adminPassword || !sessionSecret) {
    throw new Error('Укажите ADMIN_LOGIN, ADMIN_PASSWORD и SESSION_SECRET в .env перед запуском сервера.');
  }
  const now = options.now ?? (() => new Date());
  const timeZone = options.timeZone ?? process.env.CINEMA_TIMEZONE ?? process.env.CINEMA_TIME_ZONE ?? DEFAULT_TIME_ZONE;
  // Validate the configured IANA zone immediately, before touching the database.
  localDateTime(now(), timeZone);
  const db = openDatabase(options.dbPath ?? process.env.DB_PATH ?? path.join(__dirname, 'cinema.db'), {
    seed: options.seed ?? process.env.SEED_DEMO !== 'false', now, timeZone
  });
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.locals.db = db;
  app.locals.close = () => { if (db.open) db.close(); };
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.get('host')) return next(new HttpError(403, 'Запрос с другого сайта запрещён.'));
      } catch { return next(new HttpError(403, 'Некорректный источник запроса.')); }
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(session({
    name: 'cinema.sid', secret: sessionSecret, store: new SQLiteSessionStore(db),
    resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 3600000 }
  }));
  function requireAdmin(req, res, next) {
    if (!req.session?.isAdmin) return next(new HttpError(401, 'Требуется вход администратора.'));
    next();
  }
  const singleSession = db.prepare(`SELECT s.*, m.title AS movie_title, m.duration,
    (SELECT COUNT(*) FROM booking_seats bs WHERE bs.session_id = s.id) AS occupied_seats
    FROM sessions s JOIN movies m ON m.id = s.movie_id WHERE s.id = ?`);
  function findSession(id) {
    const result = singleSession.get(id);
    if (!result) fail(404, 'Сеанс не найден.');
    return result;
  }
  function sessionView(s) {
    const isPast = !isFuture(s, now(), timeZone);
    return { ...s, free_seats: SEAT_COUNT - s.occupied_seats, is_past: isPast, available: !isPast && s.occupied_seats < SEAT_COUNT };
  }
  function validMovie(body) {
    const title = text(body.title, 'Название', 1, 150);
    const genre = text(body.genre, 'Жанр', 1, 100);
    const description = text(body.description, 'Описание', 10, 4000, true);
    if (!Number.isInteger(body.duration) || body.duration < 1 || body.duration > 600) fail(400, 'Длительность должна быть целым числом от 1 до 600 минут.');
    const director = body.director == null || body.director === '' ? '' : text(body.director, 'Режиссёр', 1, 150);
    const year = body.year == null || body.year === '' ? null : body.year;
    if (year !== null && (!Number.isInteger(year) || year < 1888 || year > now().getUTCFullYear() + 5)) fail(400, 'Укажите корректный год выпуска фильма.');
    const age = body.age_rating ?? '12+';
    if (!['0+', '6+', '12+', '16+', '18+'].includes(age)) fail(400, 'Выберите допустимое возрастное ограничение.');
    return { title, genre, duration: body.duration, description, director, year, age_rating: age };
  }
  function validSession(body) {
    if (!positiveId(body.movie_id)) fail(400, 'Выберите фильм.');
    const movie = db.prepare('SELECT id, duration FROM movies WHERE id = ?').get(body.movie_id);
    if (!movie) fail(404, 'Фильм не найден.');
    if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) fail(400, 'Укажите дату в формате ГГГГ-ММ-ДД.');
    const parsed = new Date(`${body.date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== body.date) fail(400, 'Такой календарной даты не существует.');
    if (typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) fail(400, 'Укажите время в формате ЧЧ:ММ.');
    if (!Number.isSafeInteger(body.price) || body.price < 1 || body.price > 1000000) fail(400, 'Цена должна быть целым числом от 1 до 1 000 000 ₸.');
    if (!isFuture(body, now(), timeZone)) fail(400, 'Дата и время сеанса должны быть в будущем.');
    return { movie_id: movie.id, date: body.date, time: body.time, price: body.price, duration: movie.duration };
  }
  function checkOverlap(candidate, exceptId = 0) {
    const start = Date.parse(`${candidate.date}T${candidate.time}:00Z`);
    const end = start + candidate.duration * 60000;
    const conflict = db.prepare(`SELECT s.*, m.duration FROM sessions s JOIN movies m ON m.id = s.movie_id WHERE s.id <> ?`).all(exceptId).some(s => {
      const other = Date.parse(`${s.date}T${s.time}:00Z`);
      return start < other + s.duration * 60000 && other < end;
    });
    if (conflict) fail(409, 'В это время зал занят другим сеансом. Выберите время с учётом длительности фильма.');
  }
  function hasBookings(sessionId) {
    return Boolean(db.prepare('SELECT 1 FROM bookings WHERE session_id = ? LIMIT 1').get(sessionId));
  }

  app.get('/api/config', (req, res) => res.json({
    seatCount: SEAT_COUNT, rows: 5, seatsPerRow: 8, currency: 'KZT', timeZone, serverNow: now().toISOString()
  }));
  const attempts = new Map();
  app.post('/api/admin/login', (req, res, next) => {
    const key = req.ip;
    const previous = attempts.get(key);
    if (previous && previous.until > Date.now() && previous.count >= 10) return next(new HttpError(429, 'Слишком много попыток входа. Повторите через 15 минут.'));
    let body;
    try { body = objectBody(req); } catch (error) { return next(error); }
    const { login, password } = body;
    if (typeof login !== 'string' || typeof password !== 'string' || !login.trim() || !password || login.length > 150 || password.length > 1000) {
      return next(new HttpError(400, 'Введите логин и пароль администратора.'));
    }
    if (!sameSecret(login.trim(), adminLogin) || !sameSecret(password, adminPassword)) {
      const attempt = previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 900000 };
      attempt.count++;
      // Expire records and bound memory used by failed logins.
      for (const [ip, item] of attempts) if (item.until <= Date.now()) attempts.delete(ip);
      if (attempts.size < 10000 || attempts.has(key)) attempts.set(key, attempt);
      return next(new HttpError(401, 'Неверный логин или пароль.'));
    }
    attempts.delete(key);
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.isAdmin = true;
      req.session.save(saveError => saveError ? next(saveError) : res.json({ success: true, message: 'Вход выполнен.' }));
    });
  });
  app.post('/api/admin/logout', (req, res, next) => req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('cinema.sid');
    res.json({ success: true, message: 'Вы вышли из системы.' });
  }));
  app.get('/api/admin/check', requireAdmin, (req, res) => res.json({ authenticated: true }));

  app.get('/api/movies', (req, res) => res.json(db.prepare('SELECT * FROM movies ORDER BY id').all()));
  app.get('/api/movies/:id', (req, res) => {
    const movie = db.prepare('SELECT * FROM movies WHERE id = ?').get(routeId(req.params.id));
    if (!movie) fail(404, 'Фильм не найден.');
    res.json(movie);
  });
  app.post('/api/movies', requireAdmin, (req, res) => {
    const movie = validMovie(objectBody(req));
    const result = db.prepare(`INSERT INTO movies (title,genre,duration,description,director,year,age_rating)
      VALUES (@title,@genre,@duration,@description,@director,@year,@age_rating)`).run(movie);
    res.status(201).json({ ...movie, id: result.lastInsertRowid, message: 'Фильм добавлен.' });
  });
  app.delete('/api/movies/:id', requireAdmin, (req, res) => {
    const id = routeId(req.params.id);
    db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM movies WHERE id = ?').get(id)) fail(404, 'Фильм не найден.');
      if (db.prepare('SELECT 1 FROM bookings b JOIN sessions s ON s.id = b.session_id WHERE s.movie_id = ? LIMIT 1').get(id)) fail(409, 'У фильма есть бронирования. Сначала отмените их, затем удалите фильм.');
      db.prepare('DELETE FROM sessions WHERE movie_id = ?').run(id);
      db.prepare('DELETE FROM movies WHERE id = ?').run(id);
    }).immediate();
    res.json({ success: true, message: 'Фильм и его сеансы удалены.' });
  });
  app.get('/api/sessions', (req, res) => {
    if (req.query.all === '1' && !req.session?.isAdmin) fail(401, 'Требуется вход администратора.');
    const sessions = db.prepare(`SELECT s.*, m.title AS movie_title, m.duration,
      (SELECT COUNT(*) FROM booking_seats bs WHERE bs.session_id = s.id) AS occupied_seats
      FROM sessions s JOIN movies m ON m.id = s.movie_id ORDER BY s.date, s.time, s.id`).all().map(sessionView);
    res.json(req.query.all === '1' ? sessions : sessions.filter(s => !s.is_past));
  });
  app.post('/api/sessions', requireAdmin, (req, res) => {
    const result = db.transaction(() => {
      const candidate = validSession(objectBody(req));
      checkOverlap(candidate);
      const inserted = db.prepare('INSERT INTO sessions (movie_id,date,time,price) VALUES (@movie_id,@date,@time,@price)').run(candidate);
      return sessionView(findSession(inserted.lastInsertRowid));
    }).immediate();
    res.status(201).json({ ...result, message: 'Сеанс добавлен.' });
  });
  app.patch('/api/sessions/:id', requireAdmin, (req, res) => {
    const id = routeId(req.params.id);
    const result = db.transaction(() => {
      const existing = findSession(id);
      if (hasBookings(id)) fail(409, 'Нельзя изменить сеанс с бронированиями. Сначала отмените бронирования.');
      const candidate = validSession({ ...existing, ...objectBody(req) });
      checkOverlap(candidate, id);
      db.prepare('UPDATE sessions SET movie_id=@movie_id,date=@date,time=@time,price=@price WHERE id=@id').run({ ...candidate, id });
      return sessionView(findSession(id));
    }).immediate();
    res.json({ ...result, message: 'Сеанс обновлён.' });
  });
  app.delete('/api/sessions/:id', requireAdmin, (req, res) => {
    const id = routeId(req.params.id);
    db.transaction(() => {
      findSession(id);
      if (hasBookings(id)) fail(409, 'У сеанса есть бронирования. Сначала отмените их, затем удалите сеанс.');
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    }).immediate();
    res.json({ success: true, message: 'Сеанс удалён.' });
  });
  app.get('/api/occupied/:sessionId', (req, res) => {
    const id = routeId(req.params.sessionId);
    findSession(id);
    res.json(db.prepare('SELECT seat_number FROM booking_seats WHERE session_id = ? ORDER BY seat_number').all(id).map(r => r.seat_number));
  });
  app.get('/api/bookings', requireAdmin, (req, res) => {
    const rows = db.prepare(`SELECT b.*, s.date,s.time,s.price,m.title AS movie_title
      FROM bookings b JOIN sessions s ON s.id=b.session_id JOIN movies m ON m.id=s.movie_id ORDER BY b.id DESC`).all();
    res.json(rows.map(row => ({ ...row, seats: JSON.parse(row.seats) })));
  });
  app.post('/api/bookings', (req, res) => {
    const { sessionId, customerName, seats } = objectBody(req);
    if (!positiveId(sessionId)) fail(400, 'Выберите доступный сеанс.');
    const name = text(customerName, 'Имя', 2, 100);
    if (!Array.isArray(seats) || !seats.length || seats.length > SEAT_COUNT ||
        new Set(seats).size !== seats.length || !seats.every(n => Number.isInteger(n) && n >= 1 && n <= SEAT_COUNT)) fail(400, 'Выберите уникальные номера мест от 1 до 40.');
    const sorted = [...seats].sort((a, b) => a - b);
    let result;
    try {
      result = db.transaction(() => {
        const selected = findSession(sessionId);
        if (!isFuture(selected, now(), timeZone)) fail(409, 'Сеанс уже начался. Выберите другой сеанс.');
        const total = selected.price * sorted.length;
        if (!Number.isSafeInteger(selected.price) || selected.price < 1 || !Number.isSafeInteger(total)) fail(409, 'Для сеанса задана некорректная цена. Обратитесь к администратору.');
        const occupied = new Set(db.prepare('SELECT seat_number FROM booking_seats WHERE session_id = ?').all(sessionId).map(r => r.seat_number));
        if (sorted.some(n => occupied.has(n))) fail(409, 'Некоторые выбранные места уже заняты. Выберите свободные места.');
        const booking = db.prepare('INSERT INTO bookings (session_id,customer_name,seats,total) VALUES (?, ?, ?, ?)').run(sessionId, name, JSON.stringify(sorted), total);
        const insert = db.prepare('INSERT INTO booking_seats (booking_id,session_id,seat_number) VALUES (?, ?, ?)');
        for (const seat of sorted) insert.run(booking.lastInsertRowid, sessionId, seat);
        return { id: booking.lastInsertRowid, total, seats: sorted, customerName: name,
          movie_title: selected.movie_title, date: selected.date, time: selected.time, price: selected.price };
      }).immediate();
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.code === 'SQLITE_CONSTRAINT_UNIQUE') fail(409, 'Некоторые выбранные места уже заняты. Выберите свободные места.');
      throw error;
    }
    res.status(201).json({ ...result, message: 'Бронирование подтверждено.' });
  });
  app.delete('/api/bookings/:id', requireAdmin, (req, res) => {
    const id = routeId(req.params.id);
    db.transaction(() => {
      const result = db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
      if (!result.changes) fail(404, 'Бронирование не найдено.');
    }).immediate();
    res.json({ success: true, message: 'Бронирование удалено. Места снова свободны.' });
  });

  for (const [url, filename] of [['/', 'index.html'], ['/index.html', 'index.html'], ['/script.js', 'script.js'], ['/style.css', 'style.css']]) {
    app.get(url, (req, res) => res.sendFile(path.join(__dirname, filename)));
  }
  app.use((req, res) => res.status(404).json({ error: 'Страница или API-метод не найдены.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON в запросе.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Слишком большой запрос.' });
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error.code === 'SQLITE_BUSY') return res.status(503).json({ error: 'База данных занята. Повторите действие через несколько секунд.' });
    if (error.code?.startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'Действие конфликтует с существующими данными. Обновите страницу.' });
    console.error('Ошибка обработки запроса:', error.message);
    res.status(500).json({ error: 'Не удалось выполнить действие. Повторите попытку позже.' });
  });
  return app;
}

if (require.main === module) {
  try {
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть числом от 1 до 65535.');
    const app = createApp();
    const server = app.listen(port, '0.0.0.0', () => console.log(`CINEMA: сервер запущен на порту ${port}`));
    server.on('error', error => { console.error('Не удалось запустить сервер:', error.message); app.locals.close(); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { app.locals.close(); process.exit(0); }));
  } catch (error) { console.error('Ошибка запуска:', error.message); process.exitCode = 1; }
}

module.exports = { createApp };
