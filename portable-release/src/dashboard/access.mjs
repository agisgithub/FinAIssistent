import {randomBytes} from 'node:crypto';
import {fingerprint,RegistrationError} from '../onboarding/store.mjs';

const invalid=()=>{throw new RegistrationError('DASHBOARD_ACCESS','Peça “dashboard” no Telegram para receber um novo acesso privado.',401);};
const tokenHash=token=>typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token)?fingerprint(token):invalid();
export const DASHBOARD_COOKIE='__Host-finai-dashboard';
export const SESSION_SECONDS=12*3600;

// Tokens are stored only as hashes; links are single-use and sessions bind a specific budget.
export class DashboardAccess {
  constructor(db,{now=Date.now}={}) {
    this.db=db;this.now=now;
    db.exec(`CREATE TABLE IF NOT EXISTS dashboard_links(hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,alias TEXT NOT NULL,budget_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dashboard_sessions(hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,alias TEXT NOT NULL,budget_id TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
  }
  prune(){for(const table of ['dashboard_links','dashboard_sessions'])this.db.prepare(`DELETE FROM ${table} WHERE expires_at<=?`).run(this.now());}
  issue({userId,alias,budgetId}) {
    if(!Number.isSafeInteger(userId)||userId<=0||typeof alias!=='string'||!alias||typeof budgetId!=='string'||!budgetId)invalid();
    this.prune();const token=randomBytes(32).toString('base64url');
    this.db.transaction(()=>{
      this.db.prepare('DELETE FROM dashboard_links WHERE user_id=?').run(userId);
      this.db.prepare('INSERT INTO dashboard_links VALUES(?,?,?,?,?)').run(fingerprint(token),userId,alias,budgetId,this.now()+10*60000);
    })();
    return token;
  }
  exchange(token) {
    const hash=tokenHash(token);
    return this.db.transaction(()=>{
      const row=this.db.prepare('SELECT * FROM dashboard_links WHERE hash=? AND expires_at>?').get(hash,this.now());if(!row)invalid();
      this.db.prepare('DELETE FROM dashboard_links WHERE hash=?').run(hash);
      const session=randomBytes(32).toString('base64url');
      // A new login replaces existing logins for this user/base without touching another user's session.
      this.db.prepare('DELETE FROM dashboard_sessions WHERE user_id=? AND alias=?').run(row.user_id,row.alias);
      this.db.prepare('INSERT INTO dashboard_sessions VALUES(?,?,?,?,?)').run(fingerprint(session),row.user_id,row.alias,row.budget_id,this.now()+SESSION_SECONDS*1000);
      return session;
    })();
  }
  session(token) {
    const row=this.db.prepare('SELECT * FROM dashboard_sessions WHERE hash=? AND expires_at>?').get(tokenHash(token),this.now());
    if(!row)invalid();return {userId:row.user_id,alias:row.alias,budgetId:row.budget_id};
  }
  revoke(token){if(typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token))this.db.prepare('DELETE FROM dashboard_sessions WHERE hash=?').run(fingerprint(token));}
}

export function dashboardCookie(request) {
  const value=String(request.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith(DASHBOARD_COOKIE+'='));
  return value?.slice(DASHBOARD_COOKIE.length+1);
}
