import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { decodePngPhoto } from '../telegram/media.mjs';

const KEYS = 'household_id=? AND budget_id=? AND user_id=? AND chat_id=?';
export const safeHistoryText = value => String(value ?? '')
  .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, '[segredo removido]')
  .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[segredo removido]')
  .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[segredo removido]')
  .replace(/((?:token|password|senha|api[_ -]?key|chave)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[segredo removido]')
  .replace(/https?:\/\/[^\s/]+:[^\s/]+@[^\s]+/gi, '[URL com credenciais removida]');
export const safeConversationHistoryText = value => safeHistoryText(value)
  .replace(/\/(?:confirmar|cancelar)_companion(?:\s+[A-Za-z0-9_-]{24})?/gi, '[ação do companion removida do contexto]')
  .replace(/(?<![A-Za-z0-9_-])(?:m|g)_[A-Za-z0-9_-]{12}(?![A-Za-z0-9_-])/g, '[identificador do companion removido]')
  .replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{24}(?![A-Za-z0-9_-])/g, '[código de proposta removido]');
const limited = (text, max) => text.length <= max ? text : text.slice(0, max - 45).replace(/[\uD800-\uDBFF]$/, '') + '\n[conteúdo reduzido pelo limite de contexto]';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export class ConversationStore {
  constructor(store, config) {
    this.store = store; this.db = store.db; this.config = config;
    this.keys = [store.identity.householdId, store.identity.budgetId, store.identity.userId, store.identity.chatId];
    this.limits = { historyTtlMinutes: 1440, maxTurns: 12, maxContextChars: 24000, maxToolResultChars: 8000, ...config.assistant };
    this.db.prepare('INSERT OR IGNORE INTO conversation_sessions(household_id,budget_id,user_id,chat_id,updated_at) VALUES(?,?,?,?,?)').run(...this.keys, store.now());
  }
  assert(identity) { this.store.assertIdentity(identity); }
  session() { return this.db.prepare(`SELECT * FROM conversation_sessions WHERE ${KEYS}`).get(...this.keys); }
  prune() {
    const cutoff = this.store.now() - this.limits.historyTtlMinutes * 60000;
    this.store.transaction(() => {
      const expired = this.db.prepare(`UPDATE conversation_turns SET user_text=NULL,assistant_text=NULL,selection_json=NULL,response_json=NULL WHERE ${KEYS} AND created_at<? AND (user_text IS NOT NULL OR response_json IS NOT NULL OR selection_json IS NOT NULL)`).run(...this.keys, cutoff).changes;
      const rows = this.db.prepare(`SELECT id,user_text,assistant_text,selection_json FROM conversation_turns WHERE ${KEYS} AND generation=? AND state='completed' AND user_text IS NOT NULL ORDER BY created_at DESC,rowid DESC`).all(...this.keys, this.session().generation);
      let used = 0, removed = expired;
      for (const [index, row] of rows.entries()) {
        used += Buffer.byteLength(row.user_text + row.assistant_text + (row.selection_json ?? ''));
        if (index >= this.limits.maxTurns || used > this.limits.maxContextChars) {
          this.db.prepare('UPDATE conversation_turns SET user_text=NULL,assistant_text=NULL,selection_json=NULL WHERE id=?').run(row.id); removed++;
        }
      }
      if (removed) this.db.prepare(`UPDATE conversation_sessions SET truncated=1 WHERE ${KEYS}`).run(...this.keys);
      this.db.prepare('UPDATE conversation_consents SET question=NULL WHERE expires_at<? OR consumed_at IS NOT NULL').run(this.store.now());
    });
  }
  history() {
    this.prune();
    return this.db.prepare(`SELECT id,user_text,assistant_text,selection_json FROM conversation_turns WHERE ${KEYS} AND generation=? AND state='completed' AND user_text IS NOT NULL ORDER BY created_at,rowid`).all(...this.keys, this.session().generation);
  }
  selection() {
    const rows = this.history();
    const row = rows.findLast(item => item.selection_json);
    const value = row ? JSON.parse(row.selection_json) : null;
    return value && value.observedAt <= this.store.now() && this.store.now() - value.observedAt < this.limits.historyTtlMinutes * 60000 ? value : null;
  }
  digest(companionContext = null) { return createHash('sha256').update(JSON.stringify(canonical({ generation: this.session().generation, rows: this.history(), companionContext }))).digest('hex'); }
  replay(job) {
    if (!job?.id) return null;
    const row = this.db.prepare(`SELECT * FROM conversation_turns WHERE source_job_id=? AND ${KEYS}`).get(job.id, ...this.keys);
    if (!row) return null;
    if (row.state === 'running') return { text: 'A conversa foi interrompida antes de concluir. Nenhuma confirmação foi assumida. Consulte /lote ou /operacoes antes de repetir uma alteração.' };
    return row.response_json ? JSON.parse(row.response_json) : { text: 'Esta mensagem já foi processada; seu contexto foi removido. Faça uma nova pergunta.' };
  }
  begin(request, job) {
    this.assert(request.identity); this.prune();
    if (job?.id) {
      const row = this.db.prepare("SELECT payload FROM jobs WHERE id=? AND state='running'").get(job.id);
      if (!row) throw new AppError('STORAGE_FAILED');
      this.assert(JSON.parse(row.payload).identity);
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO conversation_turns(id,source_job_id,household_id,budget_id,user_id,chat_id,generation,state,created_at,user_text) VALUES(?,?,?,?,?,?,?,'running',?,?)`).run(id, job?.id ?? null, ...this.keys, this.session().generation, this.store.now(), limited(safeConversationHistoryText(request.type === 'message' ? request.text : '[botão de confirmação acionado pelo responsável]'), 4096));
    return id;
  }
  finish(turnId, response, { selection = null, provider = null, model = null } = {}) {
    if (response.photo) decodePngPhoto(response.photo);
    const clean = { text: response.text, ...(response.photo ? { photo: response.photo } : {}), ...(response.replyMarkup ? { replyMarkup: response.replyMarkup } : {}), ...(response.dedupeKey ? { dedupeKey: response.dedupeKey } : {}), ...(response.metadata ? { metadata: response.metadata } : {}) };
    const maxPart = Math.max(512, Math.floor(this.limits.maxContextChars / 3));
    let selectionJson = selection ? JSON.stringify(selection) : null;
    if (selectionJson?.length > this.limits.maxToolResultChars) selectionJson = null;
    this.db.prepare(`UPDATE conversation_turns SET state='completed',assistant_text=?,selection_json=?,response_json=?,provider=?,model=? WHERE id=? AND ${KEYS}`).run(limited(safeConversationHistoryText(response.text), maxPart), selectionJson, JSON.stringify(clean), provider, model, turnId, ...this.keys);
    this.prune(); return clean;
  }
  setProvider(provider, model = null) {
    if (!['ollama','gemini'].includes(provider)) throw new AppError('INPUT_INVALID');
    this.db.prepare(`UPDATE conversation_sessions SET provider=?,model=?,updated_at=? WHERE ${KEYS}`).run(provider, model, this.store.now(), ...this.keys);
  }
  clear(identity) {
    this.assert(identity);
    this.store.transaction(() => {
      this.db.prepare(`UPDATE conversation_turns SET user_text=NULL,assistant_text=NULL,selection_json=NULL,response_json=NULL WHERE ${KEYS}`).run(...this.keys);
      this.db.prepare(`UPDATE conversation_consents SET consumed_at=?,question=NULL WHERE ${KEYS}`).run(this.store.now(), ...this.keys);
      this.db.prepare(`UPDATE conversation_sessions SET generation=generation+1,truncated=0,updated_at=? WHERE ${KEYS}`).run(this.store.now(), ...this.keys);
    });
  }
  consent(mode, question = null, companionContext = null) {
    const nonce = randomBytes(18).toString('base64url'), now = this.store.now();
    this.db.prepare(`INSERT INTO conversation_consents(nonce,household_id,budget_id,user_id,chat_id,generation,context_hash,mode,question,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(nonce, ...this.keys, this.session().generation, this.digest(companionContext), mode, question == null ? null : safeConversationHistoryText(question), now, now + 15 * 60000);
    return nonce;
  }
  consumeConsent(nonce, identity, cancel = false, companionContext = null) {
    this.assert(identity);
    return this.store.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM conversation_consents WHERE nonce=? AND ${KEYS}`).get(nonce, ...this.keys);
      if (!row) throw new AppError('UNAUTHORIZED');
      if (row.consumed_at != null) throw new AppError('PROPOSAL_USED');
      if (row.expires_at <= this.store.now()) throw new AppError('PROPOSAL_EXPIRED');
      if (!cancel && (row.generation !== this.session().generation || row.context_hash !== this.digest(companionContext))) throw new AppError('PROPOSAL_POLICY_CHANGED');
      this.db.prepare('UPDATE conversation_consents SET consumed_at=?,question=NULL WHERE nonce=?').run(this.store.now(), nonce);
      return row;
    });
  }
}

export function pruneConversations(store, config = {}) { new ConversationStore(store, config).prune(); }
