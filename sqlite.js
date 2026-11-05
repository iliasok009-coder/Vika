'use strict';

const { DatabaseSync } = require('node:sqlite');

// Keep the small synchronous interface used by this application while relying on
// SQLite bundled with Node.js. No native npm add-on or compiler is needed.
const constraintNames = new Map([
  [275, 'CHECK'], [531, 'COMMITHOOK'], [787, 'FOREIGNKEY'],
  [1043, 'FUNCTION'], [1299, 'NOTNULL'], [1555, 'PRIMARYKEY'],
  [1811, 'TRIGGER'], [2067, 'UNIQUE'], [2323, 'VTAB'],
  [2579, 'ROWID'], [2835, 'PINNED'], [3091, 'DATATYPE']
]);
const baseNames = [
  'OK', 'ERROR', 'INTERNAL', 'PERM', 'ABORT', 'BUSY', 'LOCKED',
  'NOMEM', 'READONLY', 'INTERRUPT', 'IOERR', 'CORRUPT', 'NOTFOUND',
  'FULL', 'CANTOPEN', 'PROTOCOL', 'EMPTY', 'SCHEMA', 'TOOBIG',
  'CONSTRAINT', 'MISMATCH', 'MISUSE', 'NOLFS', 'AUTH', 'FORMAT',
  'RANGE', 'NOTADB', 'NOTICE', 'WARNING'
];

function sqliteError(error) {
  if (error.code === 'ERR_SQLITE_ERROR' && Number.isInteger(error.errcode)) {
    const base = error.errcode & 255;
    const constraint = constraintNames.get(error.errcode);
    error.code = constraint ? `SQLITE_CONSTRAINT_${constraint}` : `SQLITE_${baseNames[base] || 'ERROR'}`;
  }
  return error;
}

function attempt(callback) {
  try { return callback(); }
  catch (error) { throw sqliteError(error); }
}

class Statement {
  constructor(statement) {
    this.statement = statement;
    // Existing named bindings intentionally include extra application metadata.
    statement.setAllowUnknownNamedParameters(true);
  }

  get(...parameters) {
    return attempt(() => {
      const row = this.statement.get(...parameters);
      return row === undefined ? undefined : { ...row };
    });
  }

  all(...parameters) {
    return attempt(() => this.statement.all(...parameters).map(row => ({ ...row })));
  }

  run(...parameters) {
    return attempt(() => this.statement.run(...parameters));
  }
}

class Database {
  constructor(filename) {
    this.connection = attempt(() => new DatabaseSync(filename));
    this.savepointId = 0;
  }

  get open() { return this.connection.isOpen; }

  close() { return attempt(() => this.connection.close()); }

  exec(sql) {
    attempt(() => this.connection.exec(sql));
    return this;
  }

  prepare(sql) {
    return new Statement(attempt(() => this.connection.prepare(sql)));
  }

  pragma(sql, { simple = false } = {}) {
    const rows = this.prepare(`PRAGMA ${sql}`).all();
    return simple ? (rows.length ? Object.values(rows[0])[0] : undefined) : rows;
  }

  transaction(callback) {
    if (typeof callback !== 'function') throw new TypeError('Transaction callback must be a function.');
    const database = this;
    function wrap(mode) {
      return function (...parameters) {
        const nested = database.connection.isTransaction;
        const savepoint = `cinema_transaction_${++database.savepointId}`;
        database.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`);
        try {
          const result = callback.apply(this, parameters);
          if (result && typeof result.then === 'function') {
            throw new TypeError('SQLite transaction callbacks must be synchronous.');
          }
          database.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
          return result;
        } catch (error) {
          if (database.connection.isTransaction) {
            if (nested) {
              database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              database.exec(`RELEASE SAVEPOINT ${savepoint}`);
            } else database.exec('ROLLBACK');
          }
          throw error;
        }
      };
    }
    const transaction = wrap('DEFERRED');
    transaction.deferred = transaction;
    transaction.immediate = wrap('IMMEDIATE');
    transaction.exclusive = wrap('EXCLUSIVE');
    return transaction;
  }
}

module.exports = Database;
