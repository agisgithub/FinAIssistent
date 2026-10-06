import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { identityFromConfig } from '../src/policy/authorize.mjs';
import { StateStore } from '../src/storage/store.mjs';

export function tempDirectory(t) {
  const root = path.resolve('work/tests');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, 'case-'));
  t.after(() => {
    const relative = path.relative(root, path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe cleanup target');
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
export const inputConfig = () => ({
  householdId: 'home', telegram: { userId: 123, chatId: 123, tokenRef: 'telegram-token' },
  actual: { budgetId: 'synthetic-budget', serverURL: 'http://localhost:5006', passwordRef: 'actual-password' }
});
export const testConfig = (directory = process.cwd()) => validateConfig(inputConfig(), directory);
export function memoryStore(t, options) {
  const config = testConfig();
  const store = new StateStore(':memory:', identityFromConfig(config), options);
  t.after(() => store.close());
  return { config, store, identity: identityFromConfig(config) };
}
export const update = (id, text = '/status', overrides = {}) => ({ update_id: id, message: { from: { id: 123, is_bot: false }, chat: { id: 123, type: 'private' }, text, ...overrides } });
