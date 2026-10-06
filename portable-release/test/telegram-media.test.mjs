import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { AppError } from '../src/errors.mjs';
import { processOneDelivery } from '../src/jobs/runtime.mjs';
import { TelegramClient } from '../src/telegram/client.mjs';
import { encodePngPhoto } from '../src/telegram/media.mjs';
import { memoryStore, testConfig } from './helpers.mjs';

const bytes = PNG.sync.write(new PNG({ width: 2, height: 2 }));
const photo = encodePngPhoto(bytes, 'grafico.png');
const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('media outbox persists one bounded PNG, keeps it across rate-limit retry and deduplicates its key', async t => {
  let now = 1000, sends = 0;
  const { store } = memoryStore(t, { now: () => now });
  assert.ok(store.enqueueOutbox({ text: 'Tabela acessível', photo, dedupeKey: 'chart:one' }));
  assert.equal(store.enqueueOutbox({ text: 'Tabela acessível', photo, dedupeKey: 'chart:one' }), null);
  const telegram = { sendPhoto: async (_chat, _payload, media) => {
    sends++; assert.deepEqual(media.bytes, bytes);
    if (sends === 1) throw new AppError('TELEGRAM_RATE_LIMITED', { retryAfterSeconds: 2 });
    return 77;
  } };
  const context = { store, telegram, logger: () => {} };
  assert.equal(await processOneDelivery(context), true);
  let row = store.db.prepare('SELECT * FROM outbox').get();
  assert.equal(row.state, 'pending'); assert.deepEqual(row.media_blob, bytes);
  now += 2000;
  assert.equal(await processOneDelivery(context), true);
  row = store.db.prepare('SELECT * FROM outbox').get();
  assert.equal(row.state, 'sent'); assert.equal(row.message_id, 77); assert.equal(sends, 2);
});

test('Telegram sendPhoto builds multipart data without forcing a JSON content type', async () => {
  let observed;
  const telegram = new TelegramClient({ config: testConfig(), resolveSecret: async () => '123:FIXTURE', fetchImpl: async (url, options) => {
    observed = { url, options }; return response({ ok: true, result: { message_id: 55 } });
  } });
  assert.equal(await telegram.sendPhoto(123, { text: 'Resumo curto', reply_markup: { inline_keyboard: [] } }, { bytes, filename: 'grafico.png' }), 55);
  assert.match(observed.url, /\/sendPhoto$/); assert.equal(observed.options.headers, undefined);
  assert.ok(observed.options.body instanceof FormData);
  assert.equal(observed.options.body.get('chat_id'), '123'); assert.equal(observed.options.body.get('caption'), 'Resumo curto');
  assert.equal(observed.options.body.get('photo').type, 'image/png'); assert.equal(observed.options.body.get('photo').name, 'grafico.png');
});

test('explicit photo rejection falls back to accessible text once; uncertain delivery never does', async t => {
  const first = memoryStore(t); first.store.enqueueOutbox({ text: 'Valores em texto', photo, dedupeKey: 'fallback' });
  let photos = 0, texts = 0;
  await processOneDelivery({ store: first.store, telegram: {
    sendPhoto: async () => { photos++; throw new AppError('TELEGRAM_REJECTED'); },
    sendMessage: async (_chat, payload) => { texts++; assert.equal(payload.text, 'Valores em texto'); return 81; }
  }, logger: () => {} });
  assert.equal(first.store.db.prepare('SELECT state FROM outbox').get().state, 'sent'); assert.equal(photos, 1); assert.equal(texts, 1);

  const second = memoryStore(t); second.store.enqueueOutbox({ text: 'Valores em texto', photo, dedupeKey: 'uncertain' });
  texts = 0;
  await processOneDelivery({ store: second.store, telegram: { sendPhoto: async () => { throw new AppError('DELIVERY_UNCERTAIN'); }, sendMessage: async () => { texts++; } }, logger: () => {} });
  assert.equal(second.store.db.prepare('SELECT state FROM outbox').get().state, 'uncertain'); assert.equal(texts, 0);
});
