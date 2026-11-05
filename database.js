const Database = require('./sqlite');

const SEAT_COUNT = 40;
const DEFAULT_TIME_ZONE = 'Asia/Qyzylorda';

function localDateTime(date, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

function isFuture(session, current, timeZone) {
  return `${session.date}T${session.time}` > localDateTime(current, timeZone).slice(0, 16);
}

function openDatabase(filename, { seed = true, now = () => new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) {
  const db = new Database(filename);
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS movies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        genre TEXT NOT NULL,
        duration INTEGER NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        director TEXT NOT NULL DEFAULT '',
        year INTEGER,
        age_rating TEXT NOT NULL DEFAULT '12+'
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        movie_id INTEGER NOT NULL REFERENCES movies(id),
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        price INTEGER NOT NULL CHECK (price > 0)
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        customer_name TEXT NOT NULL,
        seats TEXT NOT NULL,
        total INTEGER NOT NULL CHECK (total > 0),
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS unique_session_time ON sessions(movie_id, date, time);
      CREATE UNIQUE INDEX IF NOT EXISTS booking_session ON bookings(id, session_id);
      CREATE TABLE IF NOT EXISTS booking_seats (
        booking_id INTEGER NOT NULL,
        session_id INTEGER NOT NULL,
        seat_number INTEGER NOT NULL CHECK (seat_number BETWEEN 1 AND ${SEAT_COUNT}),
        PRIMARY KEY (session_id, seat_number),
        FOREIGN KEY (booking_id, session_id) REFERENCES bookings(id, session_id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS booking_seats_booking ON booking_seats(booking_id);
      CREATE TABLE IF NOT EXISTS admin_sessions (
        sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL
      );
    `);
    const columns = new Set(db.prepare('PRAGMA table_info(movies)').all().map(c => c.name));
    for (const [name, definition] of [
      ['director', "TEXT NOT NULL DEFAULT ''"],
      ['year', 'INTEGER'],
      ['age_rating', "TEXT NOT NULL DEFAULT '12+'"]
    ]) {
      if (!columns.has(name)) db.exec(`ALTER TABLE movies ADD COLUMN ${name} ${definition}`);
    }

    // Backfill allocations without replacing or discarding an existing reservation.
    // A conflict in legacy data stops startup rather than silently losing somebody's seat.
    db.transaction(() => {
      const allocation = db.prepare('SELECT booking_id FROM booking_seats WHERE session_id = ? AND seat_number = ?');
      const insert = db.prepare('INSERT INTO booking_seats (booking_id, session_id, seat_number) VALUES (?, ?, ?)');
      for (const booking of db.prepare('SELECT id, session_id, seats FROM bookings').all()) {
        let seats;
        try { seats = JSON.parse(booking.seats); } catch { throw new Error(`Бронь №${booking.id}: повреждён список мест. База не изменена.`); }
        if (!Array.isArray(seats) || !seats.length || seats.length > SEAT_COUNT ||
            new Set(seats).size !== seats.length || !seats.every(n => Number.isInteger(n) && n >= 1 && n <= SEAT_COUNT)) {
          throw new Error(`Бронь №${booking.id}: некорректные места. Требуется проверка исходной базы.`);
        }
        for (const seat of seats) {
          const existing = allocation.get(booking.session_id, seat);
          if (existing && existing.booking_id !== booking.id) {
            throw new Error(`В исходной базе место ${seat} сеанса №${booking.session_id} забронировано повторно. Нужна проверка данных.`);
          }
          if (!existing) insert.run(booking.id, booking.session_id, seat);
        }
        const allocated = db.prepare('SELECT COUNT(*) AS count FROM booking_seats WHERE booking_id = ?').get(booking.id).count;
        if (allocated !== seats.length) throw new Error(`Бронь №${booking.id}: данные распределения мест не совпадают.`);
      }
      if (db.pragma('foreign_key_check').length) throw new Error('В исходной базе есть нарушенные связи. Данные сохранены; требуется проверка базы.');
    }).immediate();

    if (seed) seedExamples(db, now(), timeZone);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function seedExamples(db, current, timeZone) {
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM app_meta WHERE key = 'initial_demo_v2'").get()) return;
    if (db.prepare('SELECT COUNT(*) AS count FROM movies').get().count === 0) {
      const insert = db.prepare(`INSERT INTO movies (title, genre, duration, description, director, year, age_rating)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      insert.run('Интерстеллар', 'Фантастика, драма', 169,
        'Когда Земля становится непригодной для жизни, пилот Купер отправляется через червоточину искать новый дом для человечества. История о времени, семье и выборе, от которого зависит будущее.',
        'Кристофер Нолан', 2014, '12+');
      insert.run('Начало', 'Фантастика, триллер', 148,
        'Доминик Кобб умеет проникать в чужие сны и похищать секреты. Последнее задание требует обратного: внедрить идею и вернуться из многоуровневого мира сновидений.',
        'Кристофер Нолан', 2010, '12+');
      insert.run('Дюна', 'Фантастика, приключения', 155,
        'Пол Атрейдес прибывает на пустынную планету Арракис — единственный источник самого ценного вещества во Вселенной. Ему предстоит пережить предательство и найти свой путь среди песков.',
        'Дени Вильнёв', 2021, '12+');
    }
    // Preserve the supplied catalogue. Enrich only the exact, original demo records.
    const enrich = db.prepare(`UPDATE movies SET description = ?, director = ?, year = ?
      WHERE title = ? AND description = ? AND director = '' AND year IS NULL`);
    enrich.run('Пилот Купер отправляется через червоточину на поиски нового дома для человечества. Космическое путешествие становится историей о времени, семье и надежде.', 'Кристофер Нолан', 2014, 'Интерстеллар', 'Путешествие за пределы Земли.');
    enrich.run('Доминик Кобб проникает в чужие сны и крадёт секреты. Его последнее задание — внедрить идею в подсознание и найти дорогу обратно.', 'Кристофер Нолан', 2010, 'Начало', 'Мир сновидений и тайных операций.');
    enrich.run('Пол Атрейдес прибывает на Арракис, пустынную планету и источник самого ценного вещества во Вселенной. Борьба за власть меняет его судьбу.', 'Дени Вильнёв', 2021, 'Дюна', 'Борьба за пустынную планету.');
    const hasFuture = db.prepare('SELECT date, time FROM sessions').all().some(s => isFuture(s, current, timeZone));
    const bookingCount = db.prepare('SELECT COUNT(*) AS count FROM bookings').get().count;
    if (!hasFuture && bookingCount === 0) {
      const movies = db.prepare('SELECT id, duration FROM movies ORDER BY id LIMIT 3').all();
      const today = localDateTime(current, timeZone).slice(0, 10);
      const base = new Date(`${today}T00:00:00Z`);
      base.setUTCDate(base.getUTCDate() + 1);
      let nextStart = Date.parse(`${base.toISOString().slice(0, 10)}T11:00:00Z`);
      const insert = db.prepare('INSERT INTO sessions (movie_id, date, time, price) VALUES (?, ?, ?, ?)');
      for (const [index, movie] of movies.entries()) {
        const dateTime = new Date(nextStart).toISOString();
        insert.run(movie.id, dateTime.slice(0, 10), dateTime.slice(11, 16), 1500 + index * 300);
        nextStart += (Math.max(1, movie.duration) + 30) * 60000;
      }
    }
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('initial_demo_v2', 'done')").run();
  }).immediate();
}

module.exports = { openDatabase, localDateTime, isFuture, SEAT_COUNT, DEFAULT_TIME_ZONE };
