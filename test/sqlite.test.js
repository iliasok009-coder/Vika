const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../sqlite');

test('native SQLite rolls back an entire immediate transaction on a constraint failure', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE seats (number INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO seats (number, name) VALUES (@number, @name)');
  assert.throws(() => db.transaction(() => {
    insert.run({ number: 1, name: 'First', ignoredMetadata: true });
    insert.run({ number: 1, name: 'Conflict' });
  }).immediate(), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
  assert.deepEqual(db.prepare('SELECT * FROM seats').all(), []);
  assert.equal(db.open, true);
});

test('nested transaction failure rolls back its savepoint while keeping the outer transaction', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE entries (number INTEGER PRIMARY KEY)');
  const insert = db.prepare('INSERT INTO entries VALUES (?)');
  db.transaction(() => {
    insert.run(1);
    assert.throws(() => db.transaction(() => {
      insert.run(2);
      throw new Error('Cancel inner operation');
    }).immediate(), /Cancel inner operation/);
    insert.run(3);
  }).immediate();
  assert.deepEqual(db.prepare('SELECT number FROM entries ORDER BY number').all(), [{ number: 1 }, { number: 3 }]);
});

test('unique and foreign-key errors retain the codes used by the HTTP conflict handler', t => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE parents (id INTEGER PRIMARY KEY, name TEXT UNIQUE); CREATE TABLE children (parent_id INTEGER REFERENCES parents(id))');
  db.prepare('INSERT INTO parents VALUES (?, ?)').run(1, 'existing');
  assert.throws(() => db.prepare('INSERT INTO parents VALUES (?, ?)').run(2, 'existing'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
  assert.throws(() => db.prepare('INSERT INTO children VALUES (?)').run(99), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
});
