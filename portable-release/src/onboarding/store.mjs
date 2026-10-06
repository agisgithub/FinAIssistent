import Database from 'better-sqlite3';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export class RegistrationError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const fingerprint = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, status) => { throw new RegistrationError(code, message, status); };
export class OnboardingStore {
  constructor(filename, key, { now = Date.now, ttlMs = 30 * 60000 } = {}) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('ONBOARDING_KEY_INVALID');
    this.key = key; this.now = now; this.ttlMs = ttlMs;
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), {recursive:true,mode:0o700});
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS invites(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,chat_id INTEGER NOT NULL,
        display_name TEXT NOT NULL,code_hash TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending');
      CREATE INDEX IF NOT EXISTS invite_users ON invites(user_id,created_at);
      CREATE TABLE IF NOT EXISTS tenants(user_id INTEGER PRIMARY KEY,chat_id INTEGER NOT NULL,display_name TEXT NOT NULL,
        sealed TEXT NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pilot_messages(update_id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,text TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gateway_updates(update_id INTEGER PRIMARY KEY,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gateway_outbox(id INTEGER PRIMARY KEY,chat_id INTEGER NOT NULL,sealed TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL);
    `);
    this.db.prepare("UPDATE invites SET state='pending' WHERE state='validating' AND expires_at>?").run(now());
    this.db.prepare("UPDATE gateway_outbox SET state='uncertain' WHERE state='sending'").run();
  }
  seal(value, identity) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(String(identity)));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    return [iv,cipher.getAuthTag(),encrypted].map(v=>v.toString('base64')).join('.');
  }
  unseal(value, identity) {
    const [iv,tag,body] = value.split('.').map(v=>Buffer.from(v,'base64'));
    const cipher = createDecipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(String(identity))); cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(body),cipher.final()]).toString('utf8'));
  }
  codeHash(token,code) { return createHmac('sha256',this.key).update(`${token}:${code}`).digest('hex'); }
  createInvite({userId,chatId,displayName}) {
    if (!Number.isSafeInteger(userId) || userId<=0 || chatId!==userId) fail('PRIVATE_CHAT','Abra o bot em uma conversa privada.');
    const recent = this.db.prepare('SELECT created_at FROM invites WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(userId);
    if (recent && this.now()-recent.created_at < 30000) fail('RATE_LIMIT','Aguarde 30 segundos para pedir outro link.',429);
    const token=randomBytes(32).toString('base64url'),code=String(randomInt(100000,1000000));
    this.db.transaction(()=>{
      this.db.prepare("UPDATE invites SET state='replaced' WHERE user_id=? AND state='pending'").run(userId);
      this.db.prepare('INSERT INTO invites(token_hash,user_id,chat_id,display_name,code_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
        .run(fingerprint(token),userId,chatId,String(displayName??'').replace(/[\x00-\x1f]/g,'').slice(0,80),this.codeHash(token,code),this.now(),this.now()+this.ttlMs);
    })();
    return {token,code,expiresAt:this.now()+this.ttlMs};
  }
  invite(token,{validating=false}={}) {
    if (typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail('LINK_INVALID','Link inválido. Solicite /cadastro no Telegram.',401);
    const row=this.db.prepare('SELECT * FROM invites WHERE token_hash=?').get(fingerprint(token));
    if (!row || row.expires_at<=this.now() || row.attempts>=5 || !['pending',...(validating?['validating']:[])].includes(row.state)) fail('LINK_EXPIRED','Este link expirou ou já foi usado. Solicite /cadastro no Telegram.',401);
    return row;
  }
  claim(token,code) {
    return this.db.transaction(()=>{
      const row=this.invite(token),actual=Buffer.from(this.codeHash(token,String(code??'')),'hex'),expected=Buffer.from(row.code_hash,'hex');
      if (!timingSafeEqual(actual,expected)) {
        this.db.prepare('UPDATE invites SET attempts=attempts+1 WHERE token_hash=?').run(row.token_hash);
        return null;
      }
      this.db.prepare("UPDATE invites SET state='validating' WHERE token_hash=? AND state='pending'").run(row.token_hash);
      return row;
    })() ?? fail('CODE_INVALID','Código incorreto. Confira os seis números enviados pelo bot.',401);
  }
  release(token) { this.db.prepare("UPDATE invites SET state='pending' WHERE token_hash=? AND state='validating'").run(fingerprint(token)); }
  save(token,payload) {
    const row=this.invite(token,{validating:true});
    if(row.state!=='validating') fail('LINK_INVALID','Validação do cadastro não iniciada.');
    if(payload.config.telegram.userId!==row.user_id || payload.config.telegram.chatId!==row.chat_id) fail('IDENTITY_MISMATCH','Identidade inválida.',403);
    const sealed=this.seal(payload,row.user_id);
    this.db.transaction(()=>{
      this.db.prepare(`INSERT INTO tenants VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET chat_id=excluded.chat_id,display_name=excluded.display_name,sealed=excluded.sealed,updated_at=excluded.updated_at`)
        .run(row.user_id,row.chat_id,payload.displayName,sealed,this.now());
      this.db.prepare("UPDATE invites SET state='used' WHERE token_hash=?").run(row.token_hash);
    })();
  }
  tenant(userId) { const row=this.db.prepare('SELECT * FROM tenants WHERE user_id=?').get(userId);return row?{...this.unseal(row.sealed,userId),userId:row.user_id}:null; }
  tenants() { return this.db.prepare('SELECT user_id FROM tenants ORDER BY user_id').all().map(row=>this.tenant(row.user_id)); }
  enqueue(updateId,chatId,payload) {
    this.db.prepare('INSERT OR IGNORE INTO gateway_outbox(id,chat_id,sealed,created_at) VALUES(?,?,?,?)').run(updateId,chatId,this.seal(payload,chatId),this.now());
  }
  claimDelivery() {
    return this.db.transaction(()=>{
      const row=this.db.prepare("SELECT * FROM gateway_outbox WHERE state='pending' ORDER BY created_at,id LIMIT 1").get();
      if(!row)return null;
      this.db.prepare("UPDATE gateway_outbox SET state='sending' WHERE id=?").run(row.id);
      return {...row,payload:this.unseal(row.sealed,row.chat_id)};
    })();
  }
  finishDelivery(id,state) {this.db.prepare('UPDATE gateway_outbox SET state=? WHERE id=?').run(state,id);}
  recordUpdate(updateId,fn) {
    return this.db.transaction(()=>{
      if(this.db.prepare('SELECT 1 FROM gateway_updates WHERE update_id=?').get(updateId))return false;
      fn();
      this.db.prepare('INSERT INTO gateway_updates VALUES(?,?)').run(updateId,this.now());
      return true;
    })();
  }
  prune(){
    const cutoff=this.now()-7*86400000;
    this.db.prepare('DELETE FROM invites WHERE expires_at<?').run(this.now()-86400000);
    this.db.prepare('DELETE FROM gateway_updates WHERE created_at<?').run(cutoff);
    this.db.prepare("DELETE FROM gateway_outbox WHERE created_at<? AND state<>'pending'").run(cutoff);
    this.db.prepare('DELETE FROM pilot_messages WHERE created_at<?').run(cutoff);
  }
  expiredCursor(){const last=Number(this.db.prepare("SELECT value FROM metadata WHERE key='telegram_received_at'").get()?.value??0);return last>0&&this.now()-last>=48*3600000;}
  cursor() { return this.expiredCursor()?0:Number(this.db.prepare("SELECT value FROM metadata WHERE key='telegram_offset'").get()?.value??0); }
  advance(updateId) {
    if(!Number.isSafeInteger(updateId)||updateId<0) return;
    if(this.expiredCursor())this.db.prepare("UPDATE metadata SET value='0' WHERE key='telegram_offset'").run();
    this.db.prepare("INSERT INTO metadata VALUES('telegram_offset',?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)").run(String(updateId+1));
    this.db.prepare("INSERT INTO metadata VALUES('telegram_received_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.now()));
  }
  close(){this.db.close();}
}
