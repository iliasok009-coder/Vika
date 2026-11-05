const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const Database = require('../sqlite');
const { createApp } = require('../server');

const FIXED_NOW = '2030-05-10T10:00:00.000Z';
const credentials = { login: 'test-admin', password: 'test-password-very-long' };
const movieInput = {
  title: 'Тестовый фильм', genre: 'Драма', duration: 120,
  description: 'Полное описание фильма для проверки бронирования.',
  director: 'Тестовый режиссёр', year: 2030, age_rating: '12+',
};

async function fixture(t, { seed = false, prepare, now = FIXED_NOW } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cinema-test-'));
  const dbPath = join(directory, 'cinema.db');
  if (prepare) prepare(dbPath);
  let app, server, base, cookie = '';
  function start() {
    app = createApp({
      dbPath, seed, adminLogin: credentials.login, adminPassword: credentials.password,
      sessionSecret: 'test-session-secret-with-more-than-32-characters',
      timeZone: 'Asia/Qyzylorda', now: () => new Date(now),
    });
    return new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  }
  async function close() {
    if (!server) return;
    const activeServer = server;
    server = null;
    activeServer.closeAllConnections();
    await new Promise((resolve, reject) => activeServer.close((error) => error ? reject(error) : resolve()));
    app.locals.close();
  }
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  await start();
  const api = {
    get db() { return app.locals.db; },
    dbPath,
    async request(path, { method = 'GET', body, authenticated = true, raw } = {}) {
      const headers = {};
      if (authenticated && cookie) headers.Cookie = cookie;
      if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(base + path, {
        method, headers,
        body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data, headers: response.headers };
    },
    async login() {
      const result = await api.request('/api/admin/login', { method: 'POST', body: credentials });
      status(result, 200);
      cookie = result.headers.get('set-cookie').split(';')[0];
      return result;
    },
    async restart() { await close(); cookie = ''; await start(); },
  };
  return api;
}

function status(result, expected) {
  assert.equal(result.status, expected, JSON.stringify(result.data));
  return result.data;
}

async function addMovie(api, overrides = {}) {
  return status(await api.request('/api/movies', { method: 'POST', body: { ...movieInput, ...overrides } }), 201);
}

async function addSession(api, movieId, overrides = {}) {
  return status(await api.request('/api/sessions', {
    method: 'POST', body: { movie_id: movieId, date: '2030-05-11', time: '12:00', price: 1500, ...overrides },
  }), 201);
}

async function book(api, sessionId, seats, overrides = {}) {
  return api.request('/api/bookings', {
    method: 'POST', body: { sessionId, customerName: 'Тестовый зритель', seats, ...overrides },
  });
}

async function withSession(t) {
  const api = await fixture(t);
  await api.login();
  const movie = await addMovie(api);
  const session = await addSession(api, movie.id);
  return { api, movie, session };
}

test('public configuration is usable; source, credentials and database are never served', async (t) => {
  const api = await fixture(t);
  const config = status(await api.request('/api/config'), 200);
  assert.equal(config.seatCount, 40);
  assert.equal(config.rows, 5);
  assert.equal(config.seatsPerRow, 8);
  assert.equal(config.timeZone, 'Asia/Qyzylorda');
  for (const path of ['/.env', '/cinema.db', '/server.js', '/package.json', '/package-lock.json', '/node_modules/express/package.json', '/.git/config']) {
    const result = await api.request(path);
    // Do not include a possibly leaked response body in assertion output.
    assert.equal(result.status, 404, `Private path must return 404: ${path}`);
  }
  assert.equal((await api.request('/')).status, 200);
  assert.equal((await api.request('/script.js')).status, 200);
  assert.equal((await api.request('/style.css')).status, 200);
});

test('admin authentication protects all management routes and logout revokes access', async (t) => {
  const api = await fixture(t);
  for (const [path, method, body] of [
    ['/api/admin/check', 'GET'], ['/api/bookings', 'GET'], ['/api/sessions?all=1', 'GET'],
    ['/api/movies', 'POST', movieInput], ['/api/movies/1', 'DELETE'],
    ['/api/sessions', 'POST', {}], ['/api/sessions/1', 'PATCH', {}],
    ['/api/sessions/1', 'DELETE'], ['/api/bookings/1', 'DELETE'],
  ]) status(await api.request(path, { method, body }), 401);
  for (const body of [{}, { login: null, password: null }, { login: {}, password: {} }, { ...credentials, password: 'incorrect' }]) {
    const response = await api.request('/api/admin/login', { method: 'POST', body });
    assert.ok(response.status === 400 || response.status === 401);
  }
  const login = await api.login();
  assert.match(login.headers.get('set-cookie'), /HttpOnly/i);
  status(await api.request('/api/admin/check'), 200);
  status(await api.request('/api/admin/logout', { method: 'POST' }), 200);
  status(await api.request('/api/admin/check'), 401);
});

test('movie details round-trip through SQLite and movie deletion removes unused sessions', async (t) => {
  const api = await fixture(t);
  await api.login();
  const movie = await addMovie(api, { title: 'Фильм <тест> & история' });
  const detail = status(await api.request(`/api/movies/${movie.id}`), 200);
  assert.equal(detail.title, 'Фильм <тест> & история');
  for (const field of ['description', 'genre', 'duration', 'director', 'year', 'age_rating']) assert.equal(detail[field], movieInput[field]);
  await addSession(api, movie.id);
  status(await api.request(`/api/movies/${movie.id}`, { method: 'DELETE' }), 200);
  assert.deepEqual(status(await api.request('/api/movies'), 200), []);
  assert.deepEqual(status(await api.request('/api/sessions'), 200), []);
  status(await api.request(`/api/movies/${movie.id}`, { method: 'DELETE' }), 404);
});

test('movie input validation rejects invalid metadata rather than storing it', async (t) => {
  const api = await fixture(t);
  await api.login();
  for (const changes of [
    { title: '' }, { title: '   ' }, { title: 123 }, { genre: '' },
    { duration: 0 }, { duration: -2 }, { duration: 95.5 }, { duration: '120' },
    { year: '2030' }, { age_rating: '21+' },
  ]) {
    const result = await api.request('/api/movies', { method: 'POST', body: { ...movieInput, ...changes } });
    status(result, 400);
    assert.equal(typeof result.data.error, 'string');
  }
  assert.deepEqual(status(await api.request('/api/movies'), 200), []);
});

test('multiline movie descriptions retain paragraph breaks', async (t) => {
  const api = await fixture(t);
  await api.login();
  const description = 'Первая строка описания.\n\nНовый абзац.\r\nПоследняя строка.';
  const movie = await addMovie(api, { description });
  assert.equal(status(await api.request(`/api/movies/${movie.id}`), 200).description, description);
});

test('session management validates calendar, time, price, film and hall overlaps', async (t) => {
  const api = await fixture(t);
  await api.login();
  const movie = await addMovie(api);
  const valid = { movie_id: movie.id, date: '2030-05-11', time: '12:00', price: 1500 };
  for (const changes of [
    { date: '2030-02-30' }, { date: '2030-5-11' }, { date: '2020-01-01' },
    { time: '24:00' }, { time: '12:60' }, { price: 0 }, { price: -1 },
    { price: 100.5 }, { price: '1500' }, { movie_id: '1' },
  ]) status(await api.request('/api/sessions', { method: 'POST', body: { ...valid, ...changes } }), 400);
  status(await api.request('/api/sessions', { method: 'POST', body: { ...valid, movie_id: 99999 } }), 404);
  const session = await addSession(api, movie.id);
  const otherMovie = await addMovie(api, { title: 'Другой фильм' });
  status(await api.request('/api/sessions', {
    method: 'POST', body: { ...valid, movie_id: otherMovie.id, time: '13:30' },
  }), 409);
  const nextSession = await addSession(api, otherMovie.id, { time: '14:00' });
  status(await api.request(`/api/sessions/${nextSession.id}`, {
    method: 'PATCH', body: { movie_id: otherMovie.id, date: valid.date, time: '13:00', price: 1900 },
  }), 409);
  status(await api.request(`/api/sessions/${nextSession.id}`, {
    method: 'PATCH', body: { movie_id: otherMovie.id, date: valid.date, time: '16:00', price: 1900 },
  }), 200);
  const sessions = status(await api.request('/api/sessions'), 200);
  assert.equal(sessions.find((item) => item.id === session.id).free_seats, 40);
  assert.equal(sessions.find((item) => item.id === nextSession.id).time, '16:00');
  status(await api.request(`/api/sessions/${nextSession.id}`, { method: 'DELETE' }), 200);
  status(await api.request(`/api/sessions/${nextSession.id}`, { method: 'DELETE' }), 404);
});

test('booking computes authoritative cost, returns full confirmation and updates availability', async (t) => {
  const { api, movie, session } = await withSession(t);
  const receipt = status(await book(api, session.id, [1, 8, 40], { total: 1, customerName: '  Анна Иванова  ' }), 201);
  assert.equal(receipt.total, 4500);
  assert.equal(receipt.movie_title, movie.title);
  assert.equal(receipt.date, '2030-05-11');
  assert.equal(receipt.time, '12:00');
  assert.deepEqual(receipt.seats, [1, 8, 40]);
  assert.equal(receipt.customerName, 'Анна Иванова');
  assert.deepEqual(status(await api.request(`/api/occupied/${session.id}`), 200), [1, 8, 40]);
  const current = status(await api.request('/api/sessions'), 200)[0];
  assert.equal(current.free_seats, 37);
  assert.equal(current.occupied_seats, 3);
  const bookings = status(await api.request('/api/bookings'), 200);
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].total, 4500);
  assert.deepEqual(bookings[0].seats, [1, 8, 40]);
});

test('booking validation rejects bad names, IDs, duplicate and out-of-range seats', async (t) => {
  const { api, session } = await withSession(t);
  for (const changes of [
    { customerName: '' }, { customerName: '  ' }, { customerName: 'А' },
    { customerName: 'Я'.repeat(101) }, { customerName: {} },
    { sessionId: String(session.id) }, { sessionId: 0 },
    { seats: [] }, { seats: [0] }, { seats: [41] }, { seats: [1.5] },
    { seats: ['1'] }, { seats: [1, 1] }, { seats: null },
  ]) status(await book(api, session.id, [2], changes), 400);
  status(await book(api, 99999, [1]), 404);
  assert.deepEqual(status(await api.request(`/api/occupied/${session.id}`), 200), []);
  assert.deepEqual(status(await api.request('/api/bookings'), 200), []);
});

test('simultaneous attempts to book a seat produce one success and one conflict', async (t) => {
  const { api, session } = await withSession(t);
  const results = await Promise.all([book(api, session.id, [9]), book(api, session.id, [9])]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(status(await api.request('/api/bookings'), 200).length, 1);
  assert.deepEqual(status(await api.request(`/api/occupied/${session.id}`), 200), [9]);
});

test('independent application/database connections share the same seat uniqueness rule', async (t) => {
  const { api, session } = await withSession(t);
  const otherApp = createApp({
    dbPath: api.dbPath, seed: false,
    adminLogin: credentials.login, adminPassword: credentials.password,
    sessionSecret: 'another-test-session-secret-with-more-than-32-characters',
    timeZone: 'Asia/Qyzylorda', now: () => new Date(FIXED_NOW),
  });
  assert.notEqual(otherApp.locals.db, api.db);
  let otherServer;
  try {
    await new Promise((resolve) => {
      otherServer = otherApp.listen(0, '127.0.0.1', resolve);
    });
    const otherBooking = async () => {
      const response = await fetch(`http://127.0.0.1:${otherServer.address().port}/api/bookings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: session.id, customerName: 'Другой зритель', seats: [15] }),
      });
      return { status: response.status, data: await response.json() };
    };
    const results = await Promise.all([book(api, session.id, [15]), otherBooking()]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    assert.equal(status(await api.request('/api/bookings'), 200).length, 1);
    assert.equal(otherApp.locals.db.prepare('SELECT COUNT(*) AS count FROM booking_seats').get().count, 1);
  } finally {
    if (otherServer) {
      otherServer.closeAllConnections();
      await new Promise((resolve, reject) => otherServer.close((error) => error ? reject(error) : resolve()));
    }
    otherApp.locals.close();
  }
});

test('multi-seat conflicts are atomic and cancellation releases every reserved seat', async (t) => {
  const { api, session } = await withSession(t);
  const first = status(await book(api, session.id, [2, 3]), 201);
  status(await book(api, session.id, [1, 2, 4]), 409);
  assert.deepEqual(status(await api.request(`/api/occupied/${session.id}`), 200), [2, 3]);
  assert.equal(status(await api.request('/api/bookings'), 200).length, 1);
  const second = status(await book(api, session.id, [1, 4]), 201);
  status(await api.request(`/api/bookings/${first.id}`, { method: 'DELETE' }), 200);
  status(await api.request(`/api/bookings/${first.id}`, { method: 'DELETE' }), 404);
  assert.deepEqual(status(await api.request(`/api/occupied/${session.id}`), 200), [1, 4]);
  status(await book(api, session.id, [2, 3]), 201);
  assert.ok(second.id > first.id);
});

test('database constraint independently rejects duplicate seat allocation', async (t) => {
  const { api, session } = await withSession(t);
  const receipt = status(await book(api, session.id, [7]), 201);
  assert.throws(() => api.db.prepare(
    'INSERT INTO booking_seats (booking_id, session_id, seat_number) VALUES (?, ?, ?)',
  ).run(receipt.id, session.id, 7), (error) => error.code.startsWith('SQLITE_CONSTRAINT'));
  assert.equal(api.db.prepare('SELECT COUNT(*) AS count FROM booking_seats').get().count, 1);
});

test('admin cannot change or delete a show or movie with bookings', async (t) => {
  const { api, movie, session } = await withSession(t);
  const booking = status(await book(api, session.id, [6]), 201);
  status(await api.request(`/api/sessions/${session.id}`, {
    method: 'PATCH', body: { movie_id: movie.id, date: '2030-05-12', time: '12:00', price: 1800 },
  }), 409);
  status(await api.request(`/api/sessions/${session.id}`, { method: 'DELETE' }), 409);
  status(await api.request(`/api/movies/${movie.id}`, { method: 'DELETE' }), 409);
  assert.equal(status(await api.request('/api/bookings'), 200)[0].total, 1500);
  status(await api.request(`/api/bookings/${booking.id}`, { method: 'DELETE' }), 200);
  status(await api.request(`/api/sessions/${session.id}`, { method: 'DELETE' }), 200);
  status(await api.request(`/api/movies/${movie.id}`, { method: 'DELETE' }), 200);
});

test('past sessions stay in admin history but cannot be booked', async (t) => {
  const { api, movie } = await withSession(t);
  const past = api.db.prepare('INSERT INTO sessions (movie_id, date, time, price) VALUES (?, ?, ?, ?)')
    .run(movie.id, '2020-01-01', '12:00', 1300).lastInsertRowid;
  assert.ok(!status(await api.request('/api/sessions'), 200).some((item) => item.id === Number(past)));
  assert.ok(status(await api.request('/api/sessions?all=1'), 200).some((item) => item.id === Number(past)));
  status(await book(api, Number(past), [1]), 409);
});

test('bookings, prices and seat allocations survive closing and reopening the database', async (t) => {
  const { api, movie, session } = await withSession(t);
  const receipt = status(await book(api, session.id, [11, 12]), 201);
  await api.restart();
  assert.equal(status(await api.request(`/api/movies/${movie.id}`), 200).title, movie.title);
  assert.deepEqual(status(await api.request(`/api/occupied/${session.id}`), 200), [11, 12]);
  status(await book(api, session.id, [11]), 409);
  await api.login();
  const restored = status(await api.request('/api/bookings'), 200)[0];
  assert.equal(restored.id, receipt.id);
  assert.equal(restored.total, 3000);
});

test('existing database migration preserves legacy booking records and protects their seats', async (t) => {
  const api = await fixture(t, { prepare(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE movies (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, genre TEXT NOT NULL, duration INTEGER NOT NULL, description TEXT);
      CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, movie_id INTEGER NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, price INTEGER NOT NULL, FOREIGN KEY (movie_id) REFERENCES movies(id));
      CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, customer_name TEXT NOT NULL, seats TEXT NOT NULL, total INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (session_id) REFERENCES sessions(id));
      INSERT INTO movies (id, title, genre, duration, description) VALUES (25, 'Существующий фильм', 'Драма', 120, 'Сохранить описание');
      INSERT INTO sessions (id, movie_id, date, time, price) VALUES (50, 25, '2030-05-11', '12:00', 1700);
      INSERT INTO bookings (id, session_id, customer_name, seats, total) VALUES (75, 50, 'Существующий зритель', '[5,6]', 3400);
    `);
    db.close();
  } });
  assert.deepEqual(status(await api.request('/api/occupied/50'), 200), [5, 6]);
  status(await book(api, 50, [5]), 409);
  assert.equal(status(await api.request('/api/movies/25'), 200).description, 'Сохранить описание');
  await api.login();
  const legacy = status(await api.request('/api/bookings'), 200)[0];
  assert.equal(legacy.id, 75);
  assert.equal(legacy.customer_name, 'Существующий зритель');
  assert.equal(legacy.total, 3400);
  await api.restart();
  assert.deepEqual(status(await api.request('/api/occupied/50'), 200), [5, 6]);
  assert.equal(api.db.prepare('SELECT COUNT(*) AS count FROM booking_seats').get().count, 2);
});

test('conflicting legacy bookings block migration without removing original reservations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cinema-conflict-test-'));
  const dbPath = join(directory, 'legacy.db');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new Database(dbPath);
  let originals;
  try {
    db.exec(`
      CREATE TABLE movies (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, genre TEXT NOT NULL, duration INTEGER NOT NULL, description TEXT);
      CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, movie_id INTEGER NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, price INTEGER NOT NULL);
      CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, customer_name TEXT NOT NULL, seats TEXT NOT NULL, total INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO movies (id, title, genre, duration, description) VALUES (1, 'Сохранить фильм', 'Драма', 120, 'Сохранить описание');
      INSERT INTO sessions (id, movie_id, date, time, price) VALUES (1, 1, '2030-05-11', '12:00', 1700);
      INSERT INTO bookings (id, session_id, customer_name, seats, total) VALUES (1, 1, 'Первый зритель', '[5,6]', 3400);
      INSERT INTO bookings (id, session_id, customer_name, seats, total) VALUES (2, 1, 'Второй зритель', '[6,7]', 3400);
    `);
    originals = db.prepare('SELECT * FROM bookings ORDER BY id').all();
  } finally { db.close(); }
  assert.throws(() => createApp({
    dbPath, seed: false, adminLogin: credentials.login, adminPassword: credentials.password,
    sessionSecret: 'test-session-secret-with-more-than-32-characters',
  }), /забронировано повторно/);
  const preserved = new Database(dbPath);
  try {
    assert.deepEqual(preserved.prepare('SELECT * FROM bookings ORDER BY id').all(), originals);
    assert.equal(preserved.prepare('SELECT description FROM movies WHERE id = 1').get().description, 'Сохранить описание');
    assert.equal(preserved.prepare('SELECT COUNT(*) AS count FROM booking_seats').get().count, 0);
  } finally { preserved.close(); }
});

test('initial sample sessions are in the future and deliberately removed data does not respawn', async (t) => {
  const api = await fixture(t, { seed: true });
  const sessions = status(await api.request('/api/sessions'), 200);
  const movies = status(await api.request('/api/movies'), 200);
  assert.ok(sessions.length > 0);
  assert.ok(movies.length > 0);
  for (const session of sessions) assert.ok(session.date >= '2030-05-11');
  await api.login();
  for (const session of sessions) status(await api.request(`/api/sessions/${session.id}`, { method: 'DELETE' }), 200);
  for (const movie of movies) status(await api.request(`/api/movies/${movie.id}`, { method: 'DELETE' }), 200);
  await api.restart();
  assert.deepEqual(status(await api.request('/api/sessions'), 200), []);
  assert.deepEqual(status(await api.request('/api/movies'), 200), []);
});

test('malformed JSON, null bodies and invalid path IDs have useful client errors', async (t) => {
  const { api } = await withSession(t);
  for (const [path, method] of [['/api/bookings', 'POST'], ['/api/movies', 'POST'], ['/api/sessions', 'POST'], ['/api/admin/login', 'POST']]) {
    for (const raw of ['{invalid', 'null', '[]', '[{}]']) {
      const response = await api.request(path, { method, raw });
      status(response, 400);
      assert.equal(typeof response.data.error, 'string');
    }
  }
  for (const path of ['/api/occupied/no', '/api/movies/-1', '/api/occupied/1.5']) status(await api.request(path), 400);
});

test('session edit rejects arrays without changing the existing show', async (t) => {
  const { api, session } = await withSession(t);
  for (const body of [[], [{}]]) {
    const response = await api.request(`/api/sessions/${session.id}`, { method: 'PATCH', body });
    status(response, 400);
    assert.equal(typeof response.data.error, 'string');
  }
  const stored = status(await api.request('/api/sessions'), 200).find((item) => item.id === session.id);
  assert.equal(stored.time, '12:00');
  assert.equal(stored.price, 1500);
});
