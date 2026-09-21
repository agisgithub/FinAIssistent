import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { StateStore } from '../src/storage/store.mjs';
import { BaseRouter, confirmationReference, parseBaseCommand } from '../src/telegram/base-router.mjs';

const HASH = { principal: '1'.repeat(64), 'financa-hml2': '2'.repeat(64) };

function fixture(t) {
  const root = path.resolve('work/tests');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, 'base-router-'));
  let now = Date.parse('2026-09-20T12:00:00Z');
  const common = { householdId: 'home', userId: 123, chatId: 123, timezone: 'America/Sao_Paulo', currency: 'BRL' };
  const identities = {
    principal: { ...common, budgetId: 'budget-principal' },
    'financa-hml2': { ...common, budgetId: 'budget-hml2' }
  };
  const stores = {
    principal: new StateStore(path.join(directory, 'principal.sqlite'), identities.principal, { now: () => now }),
    'financa-hml2': new StateStore(path.join(directory, 'hml.sqlite'), identities['financa-hml2'], { now: () => now })
  };
  t.after(() => {
    Object.values(stores).forEach(store => store.close());
    rmSync(directory, { recursive: true, force: true });
  });
  const profiles = Object.keys(stores).map(alias => ({ alias, label: alias === 'principal' ? 'Principal' : 'FinAIG-hml', identity: identities[alias], policyHash: HASH[alias] }));
  const registry = { defaultAlias: 'principal', profiles };
  const runtimes = new Map(Object.entries(stores));
  const router = (options = {}) => new BaseRouter({ controlStore: stores.principal, registry, runtimes: options.runtimes ?? runtimes, authorize: options.authorize });
  const request = (text, options = {}) => options.callback
    ? { type: 'callback', callbackId: `callback-${text}`, data: text, identity: options.identity ?? identities.principal }
    : { type: 'message', text, identity: options.identity ?? identities.principal };
  return { stores, identities, registry, runtimes, router, request, at(value) { now = value; } };
}

function jobs(store) {
  return store.db.prepare('SELECT * FROM jobs ORDER BY created_at,rowid').all().map(row => ({ ...row, payload: row.payload && JSON.parse(row.payload) }));
}

function seedJob(store, suffix) {
  return store.enqueueJob({ kind: 'seed', payload: { seed: true }, dedupeKey: `seed:${suffix}` });
}

function seedNonce(store, table, nonce, suffix) {
  const identity = store.identity, now = store.now(), id = `proposal-${suffix}`, sourceJob = table === 'conversation_consents' ? null : seedJob(store, suffix);
  if (table === 'proposals') store.db.prepare(`INSERT INTO proposals(id,nonce,source_job_id,household_id,budget_id,user_id,chat_id,kind,state,before_fingerprint,after_fingerprint,policy_version,policy_hash,dry_run,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,'category','pending','before','after','v1',?,1,?,?)`).run(id, nonce, sourceJob, identity.householdId, identity.budgetId, identity.userId, identity.chatId, 'a'.repeat(64), now, now + 900000);
  else if (table === 'assistant_action_proposals') store.db.prepare(`INSERT INTO assistant_action_proposals(id,nonce,source_job_id,household_id,budget_id,user_id,chat_id,state,input_hash,policy_hash,dry_run,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,'pending',?,?,1,?,?)`).run(id, nonce, sourceJob, identity.householdId, identity.budgetId, identity.userId, identity.chatId, 'a'.repeat(64), 'b'.repeat(64), now, now + 900000);
  else if (table === 'bill_proposals') store.db.prepare(`INSERT INTO bill_proposals(id,nonce,source_job_id,household_id,budget_id,user_id,chat_id,kind,state,policy_hash,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,'unit','pending',?,?,?)`).run(id, nonce, sourceJob, identity.householdId, identity.budgetId, identity.userId, identity.chatId, 'a'.repeat(64), now, now + 900000);
  else if (table === 'companion_proposals') store.db.prepare(`INSERT INTO companion_proposals(id,nonce,source_job_id,operation_key,household_id,budget_id,user_id,chat_id,operation,state,input_hash,policy_hash,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,'record_memory','pending',?,?,?,?)`).run(id, nonce, sourceJob, `operation-${suffix}`, identity.householdId, identity.budgetId, identity.userId, identity.chatId, 'a'.repeat(64), 'b'.repeat(64), now, now + 900000);
  else if (table === 'conversation_consents') store.db.prepare(`INSERT INTO conversation_consents(nonce,household_id,budget_id,user_id,chat_id,generation,context_hash,mode,created_at,expires_at)
    VALUES(?,?,?,?,?,1,?,'once',?,?)`).run(nonce, identity.householdId, identity.budgetId, identity.userId, identity.chatId, 'a'.repeat(64), now, now + 900000);
}

test('base commands are closed and confirmation grammar identifies only known origins', () => {
  assert.deepEqual(parseBaseCommand({ type: 'message', text: '/base usar FINANCA-HML2' }), { kind: 'switch', alias: 'financa-hml2' });
  assert.deepEqual(parseBaseCommand({ type: 'message', text: '/bases extra' }), { kind: 'invalid' });
  assert.equal(confirmationReference({ type: 'callback', data: 'ai:local' }).kind, 'active');
  assert.equal(confirmationReference({ type: 'message', text: `/confirmar ${'A'.repeat(24)}` }).table, 'proposals');
  assert.equal(confirmationReference({ type: 'message', text: '/confirmar curto' }).kind, 'invalid');
  assert.equal(confirmationReference({ type: 'message', text: '/status' }), null);
});

test('same batch switch is committed before the next update and forwarding scrubs payload', async t => {
  const f = fixture(t), requests = new Map([[1, f.request('/base usar financa-hml2')], [2, f.request('/status')]]), router = f.router();
  const accepted = router.acceptBatch([{ update_id: 1 }, { update_id: 2 }], update => requests.get(update.update_id));
  assert.equal(accepted[0].kind, 'control');
  assert.equal(accepted[1].profileAlias, 'financa-hml2');
  assert.equal(router.selection().alias, 'financa-hml2');

  const forwarded = await router.forwardPending();
  assert.equal(forwarded.length, 1);
  assert.equal(jobs(f.stores.principal).length, 0);
  const target = jobs(f.stores['financa-hml2']);
  assert.equal(target.length, 1);
  assert.equal(target[0].dedupe_key, 'telegram-router:0:2');
  assert.equal(target[0].payload.identity.budgetId, 'budget-hml2');
  assert.deepEqual(target[0].payload.routing, { baseAlias: 'financa-hml2', profilePolicyHash: HASH['financa-hml2'] });
  const route = f.stores.principal.db.prepare('SELECT * FROM telegram_route_ledger WHERE update_id=2').get();
  assert.equal(route.state, 'forwarded');
  assert.equal(route.payload_json, null);
  assert.equal(route.profile_policy_hash, HASH['financa-hml2']);
  assert.ok(route.target_job_id);
  assert.match(JSON.parse(f.stores.principal.db.prepare('SELECT payload FROM outbox').get().payload).text, /financa-hml2/);
});

test('crash after target enqueue is recovered on restart without a duplicate job', async t => {
  const f = fixture(t), target = f.stores['financa-hml2'];
  let crash = true;
  const runtimes = new Map([
    ['principal', f.stores.principal],
    ['financa-hml2', { store: target, async enqueueRouted({ request, dedupeKey }) {
      const jobId = target.enqueueJob({ kind: 'command', payload: request, dedupeKey, safeRetry: true });
      if (crash) { crash = false; throw new Error('synthetic crash'); }
      return { jobId };
    } }]
  ]);
  const router = f.router({ runtimes });
  router.accept({ update_id: 7 }, f.request('/base usar financa-hml2'));
  router.accept({ update_id: 8 }, f.request('/gastos mes'));
  await assert.rejects(router.forwardPending(), /synthetic crash/);
  assert.equal(jobs(target).length, 1);
  let route = f.stores.principal.db.prepare('SELECT state,payload_json FROM telegram_route_ledger WHERE update_id=8').get();
  assert.equal(route.state, 'pending');
  assert.ok(route.payload_json);

  const restarted = f.router({ runtimes });
  const forwarded = await restarted.forwardPending();
  assert.equal(forwarded.length, 1);
  assert.equal(jobs(target).length, 1);
  route = f.stores.principal.db.prepare('SELECT state,payload_json,target_job_id FROM telegram_route_ledger WHERE update_id=8').get();
  assert.equal(route.state, 'forwarded');
  assert.equal(route.payload_json, null);
  assert.equal(route.target_job_id, jobs(target)[0].id);
});

test('every confirmation family follows the unique nonce origin instead of active base', async t => {
  const f = fixture(t), router = f.router();
  const cases = [
    ['proposals', 'cf:', '/confirmar '],
    ['assistant_action_proposals', 'bf:', '/confirmar_lote '],
    ['bill_proposals', 'rf:', '/recorrencia confirmar '],
    ['companion_proposals', 'pc:', '/confirmar_companion '],
    ['conversation_consents', 'ac:', null]
  ];
  let updateId = 20;
  for (const [index, [table, callbackPrefix, commandPrefix]] of cases.entries()) {
    const nonce = `${String.fromCharCode(65 + index).repeat(23)}${index}`;
    seedNonce(f.stores['financa-hml2'], table, nonce, `${table}-${index}`);
    router.accept({ update_id: updateId++ }, commandPrefix ? f.request(`${commandPrefix}${nonce}`) : f.request(`${callbackPrefix}${nonce}`, { callback: true }));
  }
  await router.forwardPending();
  const routed = jobs(f.stores['financa-hml2']).filter(job => job.kind === 'command');
  assert.equal(routed.length, cases.length);
  assert.ok(routed.every(job => job.payload.routing.baseAlias === 'financa-hml2'));
  assert.equal(jobs(f.stores.principal).filter(job => job.kind === 'command').length, 0);
});

test('zero or multiple nonce origins fail closed without enqueuing a mutation', async t => {
  const f = fixture(t), router = f.router(), missing = 'M'.repeat(24), duplicate = 'D'.repeat(24);
  let result = router.accept({ update_id: 40 }, f.request(`cf:${missing}`, { callback: true }));
  assert.deepEqual({ kind: result.kind, reason: result.reason }, { kind: 'rejected', reason: 'origin_not_unique' });
  seedNonce(f.stores.principal, 'conversation_consents', duplicate, 'duplicate-principal');
  seedNonce(f.stores['financa-hml2'], 'conversation_consents', duplicate, 'duplicate-hml');
  result = router.accept({ update_id: 41 }, f.request(`ac:${duplicate}`, { callback: true }));
  assert.deepEqual({ kind: result.kind, reason: result.reason }, { kind: 'rejected', reason: 'origin_not_unique' });
  assert.equal(f.stores.principal.db.prepare('SELECT COUNT(*) n FROM telegram_route_ledger').get().n, 0);
  assert.equal(jobs(f.stores.principal).filter(job => job.kind === 'command').length, 0);
  assert.equal(jobs(f.stores['financa-hml2']).filter(job => job.kind === 'command').length, 0);
  assert.equal((await router.forwardPending()).length, 0);
  const texts = f.stores.principal.db.prepare('SELECT payload FROM outbox ORDER BY rowid').all().map(row => JSON.parse(row.payload).text);
  assert.equal(texts.length, 2);
  assert.ok(texts.every(text => /Nada foi alterado/.test(text)));
  assert.ok(texts.every(text => !text.includes(missing) && !text.includes(duplicate)));
});

test('provider callbacks follow active profile while unauthorized updates only advance cursor', async t => {
  const f = fixture(t), router = f.router();
  router.accept({ update_id: 50 }, f.request('/base usar financa-hml2'));
  router.accept({ update_id: 51 }, f.request('ai:local', { callback: true }));
  router.accept({ update_id: 52 }, null);
  router.accept({ update_id: 53 }, f.request('/status', { identity: { ...f.identities.principal, userId: 999 } }));
  await router.forwardPending();
  const routed = jobs(f.stores['financa-hml2']).filter(job => job.kind === 'command');
  assert.equal(routed.length, 1);
  assert.equal(routed[0].payload.data, 'ai:local');
  assert.equal(f.stores.principal.db.prepare('SELECT authorized FROM telegram_updates WHERE update_id=52').get().authorized, 0);
  assert.equal(f.stores.principal.db.prepare('SELECT authorized FROM telegram_updates WHERE update_id=53').get().authorized, 0);
  assert.equal(router.cursor(), 54);
});

test('restart terminalizes a stale policy route and continues with the next valid route', async t => {
  const f = fixture(t), router = f.router();
  router.accept({ update_id: 60 }, f.request('/status'));
  f.registry.profiles.find(profile => profile.alias === 'principal').policyHash = 'f'.repeat(64);
  const restarted = f.router();
  restarted.accept({ update_id: 61 }, f.request('/gastos mes'));
  const results = await restarted.forwardPending();
  assert.deepEqual(results.map(result => result.kind ?? 'forwarded'), ['rejected', 'forwarded']);
  const stale = f.stores.principal.db.prepare('SELECT state,payload_json,target_job_id,rejection_code FROM telegram_route_ledger WHERE update_id=60').get();
  assert.deepEqual(stale, { state: 'rejected', payload_json: null, target_job_id: null, rejection_code: 'profile_policy_changed' });
  const next = f.stores.principal.db.prepare('SELECT state,payload_json,target_job_id,rejection_code FROM telegram_route_ledger WHERE update_id=61').get();
  assert.equal(next.state, 'forwarded');
  assert.equal(next.payload_json, null);
  assert.ok(next.target_job_id);
  assert.equal(next.rejection_code, null);
  assert.equal(jobs(f.stores.principal).length, 1);
});

test('restart terminalizes a route whose profile was removed and continues with the next valid route', async t => {
  const f = fixture(t), router = f.router();
  router.accept({ update_id: 70 }, f.request('/base usar financa-hml2'));
  router.accept({ update_id: 71 }, f.request('/status'));
  f.registry.profiles.splice(f.registry.profiles.findIndex(profile => profile.alias === 'financa-hml2'), 1);
  f.runtimes.delete('financa-hml2');
  const restarted = f.router();
  restarted.accept({ update_id: 72 }, f.request('/status'));
  const results = await restarted.forwardPending();
  assert.deepEqual(results.map(result => result.kind ?? 'forwarded'), ['rejected', 'forwarded']);
  const removed = f.stores.principal.db.prepare('SELECT state,payload_json,target_job_id,rejection_code FROM telegram_route_ledger WHERE update_id=71').get();
  assert.deepEqual(removed, { state: 'rejected', payload_json: null, target_job_id: null, rejection_code: 'profile_removed' });
  const next = f.stores.principal.db.prepare('SELECT state,payload_json,target_job_id,rejection_code FROM telegram_route_ledger WHERE update_id=72').get();
  assert.equal(next.state, 'forwarded');
  assert.equal(next.payload_json, null);
  assert.ok(next.target_job_id);
  assert.equal(next.rejection_code, null);
  assert.equal(jobs(f.stores.principal).length, 1);
  assert.equal(jobs(f.stores['financa-hml2']).filter(job => job.kind === 'command').length, 0);
});
