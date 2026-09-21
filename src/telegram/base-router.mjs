import { createHash } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { validActualBaseAlias } from '../actual/base-registry.mjs';

const NONCE = /^[A-Za-z0-9_-]{24}$/;
const POLICY_HASH = /^[a-f0-9]{64}$/;
const IDLE_RESET_MS = 48 * 60 * 60 * 1000;
const PAYLOAD_LIMIT = 16 * 1024;

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);

function registryRows(registry) {
  let values;
  if (Array.isArray(registry)) values = registry;
  else if (typeof registry?.listProfiles === 'function') values = registry.listProfiles();
  else if (typeof registry?.list === 'function') values = registry.list();
  else if (typeof registry?.profiles === 'function') values = registry.profiles();
  else values = registry?.profiles ?? registry?.bases;
  if (values instanceof Map) values = [...values.entries()].map(([alias, profile]) => ({ alias, ...profile }));
  else if (values && !Array.isArray(values) && typeof values === 'object') values = Object.entries(values).map(([alias, profile]) => ({ alias, ...profile }));
  if (!Array.isArray(values) || !values.length) throw new AppError('CONFIG_INVALID');
  return values.map(value => typeof value === 'string' ? { alias: value } : value);
}

function registryGet(registry, alias, fallback) {
  if (typeof registry?.getProfile === 'function') return registry.getProfile(alias);
  if (typeof registry?.profile === 'function') return registry.profile(alias);
  if (typeof registry?.get === 'function') return registry.get(alias);
  return fallback;
}

function runtimeGet(runtimes, alias) {
  if (typeof runtimes === 'function') return runtimes(alias);
  if (runtimes instanceof Map) return runtimes.get(alias);
  if (Array.isArray(runtimes)) return runtimes.find(runtime => (runtime?.alias ?? runtime?.key ?? runtime?.baseAlias) === alias);
  return runtimes?.[alias];
}

function runtimeStore(runtime) { return runtime?.store ?? runtime; }

function profileIdentity(profile, runtime) {
  const identity = profile?.identity ?? runtime?.identity ?? runtimeStore(runtime)?.identity;
  if (!identity || typeof identity.householdId !== 'string' || typeof identity.budgetId !== 'string' || !Number.isSafeInteger(identity.userId) || !Number.isSafeInteger(identity.chatId)) throw new AppError('CONFIG_INVALID');
  return identity;
}

function profilePolicyHash(registry, alias, profile, identity) {
  const explicit = profile?.policyHash ?? (typeof registry?.policyHash === 'function' ? registry.policyHash(alias) : null);
  if (explicit != null) {
    if (typeof explicit !== 'string' || !POLICY_HASH.test(explicit)) throw new AppError('CONFIG_INVALID');
    return explicit;
  }
  // Compatibility fallback for registries that have not materialized a hash yet.
  // The digest is stored, never the budget identifier used to derive it.
  const actual = profile?.config?.actual ?? profile?.actual ?? profile;
  return hash({
    version: 'base-route-1', alias, householdId: identity.householdId, budgetId: identity.budgetId,
    userId: identity.userId, chatId: identity.chatId,
    routePolicy: profile?.routePolicy ?? {
      serverURL: actual?.serverURL ?? null, passwordRef: actual?.passwordRef ?? null,
      encryptionPasswordRef: actual?.encryptionPasswordRef ?? null, timeoutMs: actual?.timeoutMs ?? null
    }
  });
}

function cleanLabel(value, fallback) {
  const label = String(value ?? fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return label && label.length <= 80 ? label : fallback;
}

function defaultAlias(registry, profiles) {
  const value = registry?.defaultAlias ?? registry?.defaultKey ?? registry?.defaultBase ?? registry?.defaultProfile ?? profiles.find(profile => profile.default === true)?.alias ?? profiles[0]?.alias;
  return typeof value === 'object' ? value.alias ?? value.key : value;
}

function parseBaseCommand(request) {
  if (request?.type !== 'message') return null;
  const parts = request.text.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();
  if (!['/base', '/bases'].includes(command)) return null;
  if (command === '/bases') return parts.length === 1 ? { kind: 'list' } : { kind: 'invalid' };
  if (parts.length === 1) return { kind: 'current' };
  if (parts.length === 3 && parts[1].toLowerCase() === 'usar') return { kind: 'switch', alias: parts[2].toLowerCase() };
  return { kind: 'invalid' };
}

function confirmationReference(request) {
  if (request?.type === 'callback') {
    if (request.data === 'ai:local' || request.data === 'ai:remote') return { kind: 'active' };
    const match = /^(cf|cx|bf|bx|rf|rx|pc|px|ac|ax):([A-Za-z0-9_-]{24})$/.exec(request.data);
    if (match) return { kind: 'origin', table: ({ cf: 'proposals', cx: 'proposals', bf: 'assistant_action_proposals', bx: 'assistant_action_proposals', rf: 'bill_proposals', rx: 'bill_proposals', pc: 'companion_proposals', px: 'companion_proposals', ac: 'conversation_consents', ax: 'conversation_consents' })[match[1]], nonce: match[2] };
    if (/^(?:cf|cx|bf|bx|rf|rx|pc|px|ac|ax):/.test(request.data)) return { kind: 'invalid' };
    return null;
  }
  if (request?.type !== 'message') return null;
  const parts = request.text.trim().split(/\s+/), command = parts[0]?.toLowerCase();
  const direct = {
    '/confirmar': 'proposals', '/cancelar': 'proposals',
    '/confirmar_lote': 'assistant_action_proposals', '/cancelar_lote': 'assistant_action_proposals',
    '/confirmar_companion': 'companion_proposals', '/cancelar_companion': 'companion_proposals'
  };
  if (own(direct, command)) return parts.length === 2 && NONCE.test(parts[1]) ? { kind: 'origin', table: direct[command], nonce: parts[1] } : { kind: 'invalid' };
  if (command === '/recorrencia' && ['confirmar', 'cancelar_proposta'].includes(parts[1]?.toLowerCase())) return parts.length === 3 && NONCE.test(parts[2]) ? { kind: 'origin', table: 'bill_proposals', nonce: parts[2] } : { kind: 'invalid' };
  return null;
}

function requestPayload(request, identity, alias, policyHash) {
  const routing = { baseAlias: alias, profilePolicyHash: policyHash };
  if (request.type === 'message') return { type: 'message', text: request.text, identity: { ...identity }, routing };
  return { type: 'callback', callbackId: request.callbackId, data: request.data, identity: { ...identity }, routing };
}

function parsePayload(value) {
  try { return JSON.parse(value); } catch { throw new AppError('STORAGE_FAILED'); }
}

/**
 * Durable Telegram control-plane for multiple isolated budget runtimes.
 *
 * Registry contract (aliases are public): list()/listProfiles(), get()/getProfile(),
 * defaultAlias/defaultKey, and optionally policyHash(alias). A profile may provide
 * { alias|key, label, identity, policyHash }. Runtimes are a Map/object/resolver;
 * each entry provides a StateStore directly, {store}, or enqueueRouted(input).
 */
export class BaseRouter {
  constructor({ controlStore, registry, runtimes, authorize = null }) {
    if (!controlStore?.db || !registry || !runtimes) throw new AppError('CONFIG_INVALID');
    this.store = controlStore;
    this.registry = registry;
    this.runtimes = runtimes;
    this.authorize = authorize;
    const profiles = this.#profiles();
    this.defaultAlias = defaultAlias(registry, profiles);
    if (!profiles.some(profile => profile.alias === this.defaultAlias)) throw new AppError('CONFIG_INVALID');
  }

  #profiles() {
    const seen = new Set();
    return registryRows(this.registry).map(row => {
      const alias = row.alias ?? row.key ?? row.id;
      if (!validActualBaseAlias(alias) || seen.has(alias)) throw new AppError('CONFIG_INVALID');
      seen.add(alias);
      const runtime = runtimeGet(this.runtimes, alias);
      if (!runtime) throw new AppError('CONFIG_INVALID');
      const profile = registryGet(this.registry, alias, row) ?? row;
      const identity = profileIdentity(profile, runtime);
      if (identity.householdId !== this.store.identity.householdId || identity.userId !== this.store.identity.userId || identity.chatId !== this.store.identity.chatId) throw new AppError('CONFIG_INVALID');
      return { alias, label: cleanLabel(profile.label ?? row.label, alias), identity, policyHash: profilePolicyHash(this.registry, alias, profile, identity), runtime };
    });
  }

  #profile(alias) {
    const profile = this.#profiles().find(row => row.alias === alias);
    if (!profile) throw new AppError('INPUT_INVALID');
    return profile;
  }

  #selection(identity) {
    const row = this.store.db.prepare('SELECT active_alias FROM base_route_selections WHERE household_id=? AND user_id=? AND chat_id=?').get(identity.householdId, identity.userId, identity.chatId);
    let profile;
    try { profile = this.#profile(row?.active_alias ?? this.defaultAlias); }
    catch { profile = this.#profile(this.defaultAlias); }
    this.store.db.prepare(`INSERT INTO base_route_selections(household_id,user_id,chat_id,active_alias,profile_policy_hash,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(household_id,user_id,chat_id) DO UPDATE SET active_alias=excluded.active_alias,profile_policy_hash=excluded.profile_policy_hash,updated_at=excluded.updated_at`).run(identity.householdId, identity.userId, identity.chatId, profile.alias, profile.policyHash, this.store.now());
    return profile;
  }

  #authorized(request) {
    const identity = request?.identity, owner = this.store.identity;
    if (!identity || identity.householdId !== owner.householdId || identity.userId !== owner.userId || identity.chatId !== owner.chatId) return false;
    if (request.type === 'message') return typeof request.text === 'string' && request.text.length >= 1 && request.text.length <= 4096;
    return request.type === 'callback' && typeof request.callbackId === 'string' && request.callbackId.length <= 256 && typeof request.data === 'string' && Buffer.byteLength(request.data) <= 64;
  }

  #origin(table, nonce) {
    const matches = [];
    for (const profile of this.#profiles()) {
      const db = runtimeStore(profile.runtime)?.db;
      if (!db) throw new AppError('CONFIG_INVALID');
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!exists) continue;
      const row = db.prepare(`SELECT 1 FROM ${table} WHERE nonce=? AND household_id=? AND budget_id=? AND user_id=? AND chat_id=? LIMIT 1`).get(nonce, profile.identity.householdId, profile.identity.budgetId, profile.identity.userId, profile.identity.chatId);
      if (row) matches.push(profile);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  #message(text, epoch, updateId) {
    this.store.enqueueOutbox({ text, dedupeKey: `base-router:${epoch}:${updateId}`, suppressBaseFooter: true });
  }

  #accept(updateId, request) {
    if (!Number.isSafeInteger(updateId) || updateId < 0 || updateId === Number.MAX_SAFE_INTEGER) throw new AppError('INPUT_INVALID');
    return this.store.transaction(() => {
      const authorized = this.#authorized(request);
      const expired = this.store.telegramEpochExpired();
      let epoch = Number(this.store.db.prepare("SELECT value FROM metadata WHERE key='telegram_epoch'").get()?.value ?? 0);
      if (expired) {
        epoch++;
        this.store.db.prepare("INSERT INTO metadata VALUES ('telegram_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(epoch));
        this.store.db.prepare("INSERT INTO metadata VALUES ('telegram_offset','0') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
      }
      const inserted = this.store.db.prepare('INSERT OR IGNORE INTO telegram_updates VALUES (?,?,?,?)').run(epoch, updateId, this.store.now(), authorized ? 1 : 0).changes;
      this.store.db.prepare("INSERT INTO metadata VALUES ('telegram_last_received_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.store.now()));
      this.store.db.prepare("INSERT INTO metadata VALUES ('telegram_offset',?) ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)").run(String(updateId + 1));
      if (!inserted || !authorized) return null;

      const base = parseBaseCommand(request);
      if (base) {
        const current = this.#selection(request.identity);
        if (base.kind === 'list') {
          const lines = this.#profiles().map(profile => `${profile.alias}${profile.alias === current.alias ? ' (ativa)' : ''} — ${profile.label}`);
          this.#message(`Bases disponíveis:\n${lines.join('\n')}\n\nUse /base usar ALIAS.`, epoch, updateId);
          return { kind: 'control', action: 'list', epoch, updateId, activeAlias: current.alias };
        }
        if (base.kind === 'current') {
          this.#message(`Base ativa: ${current.alias} — ${current.label}.`, epoch, updateId);
          return { kind: 'control', action: 'current', epoch, updateId, activeAlias: current.alias };
        }
        if (base.kind === 'switch' && validActualBaseAlias(base.alias)) {
          let selected;
          try { selected = this.#profile(base.alias); } catch { selected = null; }
          if (selected) {
            this.store.db.prepare(`INSERT INTO base_route_selections(household_id,user_id,chat_id,active_alias,profile_policy_hash,updated_at) VALUES(?,?,?,?,?,?)
              ON CONFLICT(household_id,user_id,chat_id) DO UPDATE SET active_alias=excluded.active_alias,profile_policy_hash=excluded.profile_policy_hash,updated_at=excluded.updated_at`).run(request.identity.householdId, request.identity.userId, request.identity.chatId, selected.alias, selected.policyHash, this.store.now());
            this.#message(`Base alterada para ${selected.alias} — ${selected.label}. As próximas mensagens usarão esta base.`, epoch, updateId);
            return { kind: 'control', action: 'switch', epoch, updateId, activeAlias: selected.alias };
          }
        }
        this.#message('Base inválida. Use /bases para ver os aliases disponíveis.', epoch, updateId);
        return { kind: 'rejected', reason: 'invalid_base_command', epoch, updateId };
      }

      const confirmation = confirmationReference(request);
      let profile;
      if (confirmation?.kind === 'invalid') {
        this.#message('Confirmação inválida. Abra uma nova proposta; nada foi alterado.', epoch, updateId);
        return { kind: 'rejected', reason: 'invalid_confirmation', epoch, updateId };
      }
      if (confirmation?.kind === 'origin') {
        profile = this.#origin(confirmation.table, confirmation.nonce);
        if (!profile) {
          this.#message('Não foi possível identificar uma única base de origem para esta confirmação. Nada foi alterado.', epoch, updateId);
          return { kind: 'rejected', reason: 'origin_not_unique', epoch, updateId };
        }
      } else profile = this.#selection(request.identity);

      const payload = JSON.stringify(requestPayload(request, profile.identity, profile.alias, profile.policyHash));
      if (Buffer.byteLength(payload) > PAYLOAD_LIMIT) throw new AppError('INPUT_INVALID');
      const dedupeKey = `telegram-router:${epoch}:${updateId}`;
      this.store.db.prepare(`INSERT INTO telegram_route_ledger(epoch,update_id,household_id,user_id,chat_id,profile_alias,profile_policy_hash,state,payload_json,target_dedupe_key,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?)`).run(epoch, updateId, request.identity.householdId, request.identity.userId, request.identity.chatId, profile.alias, profile.policyHash, payload, dedupeKey, this.store.now(), this.store.now());
      return { kind: 'pending', epoch, updateId, profileAlias: profile.alias, profilePolicyHash: profile.policyHash, dedupeKey };
    });
  }

  accept(update, authorizedRequest) {
    if (!update || typeof update !== 'object') throw new AppError('INPUT_INVALID');
    let request = authorizedRequest;
    if (arguments.length < 2) {
      if (typeof this.authorize !== 'function') throw new AppError('CONFIG_INVALID');
      request = this.authorize(update);
    }
    return this.#accept(update.update_id, request);
  }

  acceptBatch(updates, authorize = this.authorize) {
    if (!Array.isArray(updates) || typeof authorize !== 'function') throw new AppError('INPUT_INVALID');
    return updates.map(update => this.#accept(update?.update_id, authorize(update)));
  }

  async #forward(row) {
    const profile = this.#profiles().find(candidate => candidate.alias === row.profile_alias);
    if (!profile) {
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE telegram_route_ledger SET state='rejected',payload_json=NULL,rejection_code='profile_removed',updated_at=? WHERE epoch=? AND update_id=? AND state='pending'")
          .run(this.store.now(), row.epoch, row.update_id);
      });
      return { kind: 'rejected', reason: 'profile_removed', epoch: row.epoch, updateId: row.update_id, profileAlias: row.profile_alias };
    }
    if (profile.policyHash !== row.profile_policy_hash) {
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE telegram_route_ledger SET state='rejected',payload_json=NULL,rejection_code='profile_policy_changed',updated_at=? WHERE epoch=? AND update_id=? AND state='pending'")
          .run(this.store.now(), row.epoch, row.update_id);
      });
      return { kind: 'rejected', reason: 'profile_policy_changed', epoch: row.epoch, updateId: row.update_id, profileAlias: profile.alias };
    }
    const runtime = profile.runtime, store = runtimeStore(runtime), payload = parsePayload(row.payload_json);
    let result;
    if (typeof runtime?.enqueueRouted === 'function') result = await runtime.enqueueRouted({ request: payload, dedupeKey: row.target_dedupe_key, epoch: row.epoch, updateId: row.update_id, profileAlias: profile.alias, profilePolicyHash: profile.policyHash });
    else {
      if (typeof store?.enqueueJob !== 'function') throw new AppError('CONFIG_INVALID');
      result = store.enqueueJob({ kind: 'command', payload, dedupeKey: row.target_dedupe_key, safeRetry: true });
    }
    let jobId = typeof result === 'string' ? result : result?.jobId ?? null;
    if (!jobId && store?.db) jobId = store.db.prepare('SELECT id FROM jobs WHERE dedupe_key=?').get(row.target_dedupe_key)?.id ?? null;
    if (!jobId) throw new AppError('STORAGE_FAILED');
    this.store.transaction(() => {
      const current = this.store.db.prepare('SELECT state,profile_policy_hash FROM telegram_route_ledger WHERE epoch=? AND update_id=?').get(row.epoch, row.update_id);
      if (!current || current.state === 'forwarded') return;
      if (current.profile_policy_hash !== profile.policyHash) throw new AppError('PROPOSAL_POLICY_CHANGED');
      this.store.db.prepare("UPDATE telegram_route_ledger SET state='forwarded',payload_json=NULL,target_job_id=?,forwarded_at=?,updated_at=? WHERE epoch=? AND update_id=? AND state='pending'").run(jobId, this.store.now(), this.store.now(), row.epoch, row.update_id);
    });
    return { epoch: row.epoch, updateId: row.update_id, profileAlias: profile.alias, jobId };
  }

  async forwardPending({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new AppError('INPUT_INVALID');
    const rows = this.store.db.prepare("SELECT * FROM telegram_route_ledger WHERE state='pending' ORDER BY created_at,epoch,update_id LIMIT ?").all(limit);
    const forwarded = [];
    for (const row of rows) forwarded.push(await this.#forward(row));
    return forwarded;
  }

  async forwardOne() {
    const row = this.store.db.prepare("SELECT * FROM telegram_route_ledger WHERE state='pending' ORDER BY created_at,epoch,update_id LIMIT 1").get();
    if (!row) return false;
    await this.#forward(row);
    return true;
  }

  cursor() { return this.store.cursor(); }

  selection() {
    const profile = this.store.transaction(() => this.#selection(this.store.identity));
    return { alias: profile.alias, label: profile.label, policyHash: profile.policyHash };
  }

  prune(retentionDays = 90) {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new AppError('INPUT_INVALID');
    return this.store.db.prepare("DELETE FROM telegram_route_ledger WHERE state IN ('forwarded','rejected') AND updated_at<?").run(this.store.now() - retentionDays * 86400000).changes;
  }
}

export { parseBaseCommand, confirmationReference };
