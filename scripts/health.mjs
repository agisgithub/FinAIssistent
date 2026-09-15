import Database from 'better-sqlite3';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
let db;
try {
  const config = await loadConfig();
  db = new Database(path.join(config.dataDir, 'state.sqlite'), { readonly: true, fileMustExist: true, timeout: 1000 });
  const at = Number(db.prepare("SELECT value FROM metadata WHERE key='heartbeat_at'").get()?.value ?? 0);
  const age = Date.now() - at;
  process.exitCode = at > 0 && age >= 0 && age < 180000 ? 0 : 1;
} catch { process.exitCode = 1; }
finally { db?.close(); }
