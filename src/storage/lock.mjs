import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors.mjs';

// Hold a transaction on a separate rollback-mode DB. Closing the connection or
// process releases the OS lock, including after a crash. Never delete this file.
export function acquireLock(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDir, 'runtime-lock.sqlite');
  let db;
  try {
    db = new Database(filename, { timeout: 0 });
    if (process.platform !== 'win32') chmodSync(filename, 0o600);
    db.pragma('journal_mode = DELETE');
    db.exec('BEGIN EXCLUSIVE');
  } catch {
    db?.close();
    throw new AppError('ALREADY_RUNNING');
  }
  return () => { if (db.open) { db.exec('ROLLBACK'); db.close(); } };
}
