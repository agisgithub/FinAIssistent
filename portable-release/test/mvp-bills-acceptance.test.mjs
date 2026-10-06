import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { StateStore } from '../src/storage/store.mjs';
import { identityFromConfig } from '../src/policy/authorize.mjs';
import { normalizeSnapshot } from '../src/actual/snapshot.mjs';
import { createCommandHandler } from '../src/telegram/commands.mjs';
import { acceptTelegramUpdate } from '../src/telegram/ingress.mjs';
import { processOneJob, processOneDelivery } from '../src/jobs/runtime.mjs';
import { BillService } from '../src/application/bills.mjs';
import { BillScheduler } from '../src/jobs/bill-scheduler.mjs';
import { ReportScheduler } from '../src/jobs/scheduler.mjs';
import { Schedulers } from '../src/jobs/schedulers.mjs';
import { AppError } from '../src/errors.mjs';
import { tempDirectory, testConfig } from './helpers.mjs';

test('MVP Telegram acceptance: confirmed local bill survives Actual outage, restart and manual paid/reopen without SDK writes', { timeout: 30000 }, async t => {
  let store;
  t.after(() => { if (store?.db.open) store.close(); });
  const directory = tempDirectory(t), config = testConfig(directory), identity = identityFromConfig(config);
  const filename = path.join(directory, 'mvp-state.sqlite');
  let clock = Date.parse('2026-09-01T10:00:00Z'), updateId = 0, offline = false;
  let modelCalls = 0, readAttempts = 0, unavailableReads = 0;
  const sdkWrites = [], messages = [], logs = [];
  const fakeReads = {
    snapshot: async period => {
      readAttempts++;
      if (offline) { unavailableReads++; throw new AppError('ACTUAL_TIMEOUT'); }
      return normalizeSnapshot({
        config, period, syncedAt: new Date(clock).toISOString(),
        accounts: [{ id: 'account_mvp', name: 'Conta fictícia de operação', balance: 123000 }],
        categories: [{ id: 'expense_mvp', name: 'Energia fictícia', group_id: 'group_mvp' }],
        categoryGroups: [{ id: 'group_mvp', name: 'Despesas fictícias' }],
        payees: [{ id: 'payee_mvp', name: 'Fornecedor fictício de energia' }],
        transactions: [], budgetMonths: []
      });
    },
    readSchedules: async () => {
      readAttempts++;
      if (offline) { unavailableReads++; throw new AppError('ACTUAL_TIMEOUT'); }
      return { ...identity, rulesVersion: 'schedules-1', coverage: { complete: true }, schedules: [], syncedAt: new Date(clock).toISOString(), createdAt: new Date(clock).toISOString() };
    }
  };
  // Any unexpected SDK-domain method is recorded and fails. Assertions happen
  // outside adapters so the runtime cannot swallow an assertion as an error.
  const actual = new Proxy(fakeReads, { get(target, key) {
    if (key in target) return target[key];
    return async () => { sdkWrites.push(String(key)); throw new Error('UNEXPECTED_SDK_METHOD'); };
  } });
  const telegram = {
    sendMessage: async (chatId, payload) => { messages.push({ chatId, payload: structuredClone(payload), at: clock }); return messages.length; },
    answerCallbackQuery: async () => {}
  };
  const logger = (event, fields) => logs.push({ event, fields });
  let handler, scheduler;
  const open = () => {
    store = new StateStore(filename, identity, { now: () => clock });
    store.recover(); store.bindTelegramBot(987654321);
    const service = new BillService({ config, store, actual, now: () => new Date(clock) });
    const report = new ReportScheduler({ config, store, actual, now: () => clock, upcomingProvider: options => service.getUpcoming(options) });
    scheduler = new Schedulers([report, new BillScheduler({ config, store, service, now: () => clock })]);
    handler = createCommandHandler({ config, store, actual, now: () => new Date(clock), billService: service, reportScheduler: report, intentClient: { interpret: async () => { modelCalls++; throw new AppError('OLLAMA_UNAVAILABLE'); } } });
  };
  const context = () => ({ store, handler, telegram, logger, scheduler });
  const jobsOnly = async () => {
    for (let count = 0; count < 100; count++) if (!(await processOneJob(context()))) return;
    assert.fail('Synthetic job queue did not settle');
  };
  const drain = async () => {
    for (let count = 0; count < 100; count++) {
      const job = await processOneJob(context()), delivered = await processOneDelivery(context());
      if (delivered) clock += 1500; // Respect the real outbox chat pacing.
      if (!job && !delivered) return;
    }
    assert.fail('Synthetic runtime did not settle');
  };
  const ingress = text => {
    const update = { update_id: ++updateId, message: { from: { id: config.telegram.userId, is_bot: false }, chat: { id: config.telegram.chatId, type: 'private' }, text } };
    assert.ok(acceptTelegramUpdate(update, config, store));
    return update;
  };
  const command = async text => {
    const start = messages.length;
    ingress(text); await drain();
    const output = messages.slice(start).map(message => message.payload.text).join('\n');
    assert.ok(output, `No user-visible response for ${text.split(' ')[0]}`);
    return output;
  };
  const proposalNonce = text => {
    const match = /\/recorrencia confirmar ([A-Za-z0-9_-]+)/.exec(text);
    assert.ok(match, 'A confirmation must be visible in the user-facing proposal');
    return match[1];
  };
  const confirm = nonce => command(`/recorrencia confirmar ${nonce}`);
  const restart = () => { store.close(); open(); };
  const notices = occurrenceId => messages.filter(message => message.payload.text.includes(`/ocorrencia ${occurrenceId}`) && message.payload.text.includes('aviso programado'));
  const pendingNotices = occurrenceId => store.db.prepare("SELECT id,payload FROM outbox WHERE state='pending'").all().filter(row => {
    const text = JSON.parse(row.payload).text;
    return text.includes(`/ocorrencia ${occurrenceId}`) && text.includes('aviso programado');
  });

  open();
  assert.equal(config.dryRun, true, 'Local settings and manual facts are allowed in simulation');
  const unitProposal = await command('/unidade cadastrar nome="Apartamento fictício"');
  assert.match(await command('/unidades'), /Nenhuma unidade/);
  assert.match(await confirm(proposalNonce(unitProposal)), /Alteração LOCAL confirmada/);
  const units = await command('/unidades'), unitId = /^ID: ([A-Za-z0-9_-]+)$/m.exec(units)?.[1];
  assert.ok(unitId); assert.match(units, /Apartamento fictício/);

  assert.match(await command('/contas'), /account_mvp/);
  assert.match(await command('/recorrencias favorecidos'), /payee_mvp/);
  const billProposal = await command(`/recorrencia cadastrar nome="Energia fictícia do apartamento" unidade=${unitId} favorecido=payee_mvp conta=account_mvp inicio=2026-09 dia=20 mes_offset=0 tipo_data=confirmado valor_centavos=10000 lembretes=sim`);
  assert.match(billProposal, /Lembretes ativados/);
  assert.doesNotMatch(await command('/proximos_vencimentos 2026-09'), /2026-09-20/);
  await confirm(proposalNonce(billProposal));
  const calendar = await command('/proximos_vencimentos 2026-09');
  const occurrenceId = /2026-09-20[^\n]*\/ocorrencia ([A-Za-z0-9_-]+)/.exec(calendar)?.[1];
  assert.ok(occurrenceId); assert.match(calendar, /100,00/);
  assert.equal(notices(occurrenceId).length, 0, 'Enrollment predates the first reminder slot');

  offline = true;
  clock = Date.parse('2026-09-13T10:59:50Z'); // 07:59:50 in the financial timezone.
  scheduler.tick(); await drain();
  assert.equal(notices(occurrenceId).length, 0);
  clock = Date.parse('2026-09-13T11:00:00Z');
  scheduler.tick(); await drain();
  assert.equal(notices(occurrenceId).length, 1);
  assert.match(notices(occurrenceId)[0].payload.text, /em 7 dia/);
  assert.match(notices(occurrenceId)[0].payload.text, /Apartamento fictício/);
  assert.ok(unavailableReads > 0, 'An actual reconciliation outage was exercised');
  const readsBeforeLocalQueries = readAttempts;
  assert.match(await command('/proximos_vencimentos 2026-09'), /2026-09-20/);
  assert.match(await command(`/ocorrencia ${occurrenceId}`), /Pagamento manual: não confirmado/);
  assert.equal(readAttempts, readsBeforeLocalQueries, 'Known local calendar queries do not depend on Actual');
  restart();
  for (let i = 0; i < 3; i++) { scheduler.tick(); await drain(); }
  assert.equal(notices(occurrenceId).length, 1, 'Sent reminder remains deduplicated across restart/ticks');

  // Prepare payment before the next slot. The proposal does not change the
  // local state. Confirm after a reminder is pending, before delivering it.
  clock = Date.parse('2026-09-17T10:59:30Z');
  const paidProposal = await command(`/pago ${occurrenceId}`);
  assert.match(await command(`/ocorrencia ${occurrenceId}`), /Pagamento manual: não confirmado/);
  clock = Date.parse('2026-09-17T11:00:00Z'); scheduler.tick();
  const pending = pendingNotices(occurrenceId);
  assert.equal(pending.length, 1);
  const paidUpdate = ingress(`/recorrencia confirmar ${proposalNonce(paidProposal)}`);
  await jobsOnly();
  assert.equal(pendingNotices(occurrenceId).length, 0);
  assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=?').get(pending[0].id).state, 'failed');
  await drain();
  assert.equal(notices(occurrenceId).length, 1, 'A pending reminder was cancelled before Telegram delivery');
  assert.match(await command(`/ocorrencia ${occurrenceId}`), /pagamento confirmado manualmente/);
  assert.doesNotMatch(await command('/proximos_vencimentos 2026-09'), new RegExp(occurrenceId));

  restart();
  const beforeReplay = messages.length;
  assert.equal(acceptTelegramUpdate(paidUpdate, config, store), null);
  scheduler.tick(); await drain();
  assert.equal(messages.length, beforeReplay, 'Replayed Telegram confirmation cannot produce another effect/output');
  const reopenProposal = await command(`/reabrir ${occurrenceId}`);
  assert.match(await command(`/ocorrencia ${occurrenceId}`), /pagamento confirmado manualmente/);
  await confirm(proposalNonce(reopenProposal));
  assert.match(await command(`/ocorrencia ${occurrenceId}`), /Pagamento manual: não confirmado/);
  assert.match(await command('/proximos_vencimentos 2026-09'), new RegExp(occurrenceId));
  const afterExplicitReopen = notices(occurrenceId).length;
  restart();
  for (let i = 0; i < 3; i++) { scheduler.tick(); await drain(); }
  assert.equal(notices(occurrenceId).length, afterExplicitReopen, 'Explicit reopen permits a new reminder revision, then deduplicates it');
  assert.equal(modelCalls, 0);
  assert.deepEqual(sdkWrites, []);
  assert.ok(messages.every(message => message.chatId === identity.chatId));
  assert.equal(logs.some(row => row.event === 'delivery_failed'), false);
});
