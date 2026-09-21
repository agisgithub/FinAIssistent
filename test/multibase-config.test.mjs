import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateConfig } from '../src/config.mjs';
import {
  DEFAULT_ACTUAL_BASE,
  MAX_ACTUAL_BASES,
  actualProfileAliases,
  actualProfileConfig,
  actualProfileIdentity,
  actualProfiles,
  actualSecretReferences,
  validActualBaseAlias
} from '../src/actual/base-registry.mjs';
import { inputConfig } from './helpers.mjs';

const leaf = (budgetId, serverURL = 'http://localhost:5006', passwordRef = 'actual-password') => ({
  serverURL, budgetId, passwordRef, encryptionPasswordRef: null
});

const multi = () => ({
  ...inputConfig(),
  actual: {
    defaultBase: 'principal',
    bases: {
      principal: leaf('principal-budget'),
      'financa-hml2': leaf('hml-budget', 'http://localhost:5007')
    }
  }
});

test('legacy Actual config normalizes to the principal profile without moving its runtime data', () => {
  const config = validateConfig(inputConfig(), '/srv/finaissistent');
  assert.equal(config.actual.defaultBase, DEFAULT_ACTUAL_BASE);
  assert.deepEqual(actualProfileAliases(config), ['principal']);
  assert.equal(config.actual.bases.principal, config.actual.bases[config.actual.defaultBase]);
  assert.equal(config.actual.budgetId, 'synthetic-budget');
  assert.equal(actualProfileConfig(config, 'principal').dataDir, path.resolve('/srv/finaissistent/data'));
  assert.ok(Object.isFrozen(config.actual));
  assert.ok(Object.isFrozen(config.actual.bases));
  assert.ok(Object.isFrozen(config.actual.bases.principal));
});

test('multi-base profiles expose default compatibility fields and isolated runtime configs', () => {
  const config = validateConfig(multi(), '/srv/finaissistent');
  assert.equal(config.actual.budgetId, 'principal-budget');
  assert.equal(config.actual.serverURL, 'http://localhost:5006');
  assert.deepEqual(actualProfileAliases(config), ['principal', 'financa-hml2']);
  const hml = actualProfileConfig(config, 'financa-hml2');
  assert.equal(hml.dataDir, path.join(config.dataDir, 'bases', 'financa-hml2'));
  assert.equal(hml.actual.budgetId, 'hml-budget');
  assert.equal(Object.hasOwn(hml.actual, 'bases'), false);
  assert.deepEqual(actualProfileIdentity(config, 'financa-hml2'), {
    baseAlias: 'financa-hml2', householdId: 'home', budgetId: 'hml-budget',
    userId: 123, chatId: 123, timezone: 'America/Sao_Paulo', currency: 'BRL'
  });
  assert.deepEqual(actualProfiles(config).map(profile => profile.alias), ['principal', 'financa-hml2']);
});

test('changing the default does not relocate the principal state directory', () => {
  const input = multi(); input.actual.defaultBase = 'financa-hml2';
  const config = validateConfig(input, '/srv/finaissistent');
  assert.equal(config.actual.budgetId, 'hml-budget');
  assert.equal(actualProfileConfig(config, 'principal').dataDir, config.dataDir);
  assert.equal(actualProfileConfig(config, 'financa-hml2').dataDir, path.join(config.dataDir, 'bases', 'financa-hml2'));
});

test('a registry requires principal even when another profile is the default', () => {
  const valid = multi(); valid.actual.defaultBase = 'financa-hml2';
  assert.doesNotThrow(() => validateConfig(valid));
  const missingPrincipal = multi(); missingPrincipal.actual.defaultBase = 'financa-hml2'; delete missingPrincipal.actual.bases.principal;
  assert.throws(() => validateConfig(missingPrincipal), /CONFIG_INVALID/);
});

test('safe aliases are bounded and registry validation fails closed', () => {
  assert.equal(validActualBaseAlias('financa-hml2'), true);
  for (const alias of ['', 'Financa', '../hml', 'a'.repeat(33), '__proto__', 'constructor']) assert.equal(validActualBaseAlias(alias), false);
  const invalid = [
    value => { value.actual.defaultBase = 'missing'; },
    value => { value.actual.bases['../escape'] = leaf('escape'); },
    value => { value.actual.bases.principal.extra = true; },
    value => { value.actual.bases.principal.budgetId = 'REPLACE_WITH_SECRET'; },
    value => { value.actual.bases.principal.serverURL = 'https://user:CANARY_SECRET@example.com'; },
    value => { value.actual.bases.principal.passwordRef = '../CANARY_SECRET'; },
    value => { value.actual.bases = Object.fromEntries(Array.from({ length: MAX_ACTUAL_BASES + 1 }, (_, index) => [`base-${index}`, leaf(`budget-${index}`)])); value.actual.defaultBase = 'base-0'; }
  ];
  for (const mutate of invalid) {
    const value = multi(); mutate(value);
    assert.throws(() => validateConfig(value), error => error.message === 'CONFIG_INVALID' && !JSON.stringify(error).includes('CANARY'));
  }
});

test('Gemini reference cannot collide with any Actual profile while Actual profiles may share a password', () => {
  const input = multi();
  input.privacy = { externalProviders: true };
  input.gemini = { enabled: true, model: 'gemini-3.8-flash', apiKeyRef: 'hml-secret' };
  input.actual.bases['financa-hml2'].passwordRef = 'hml-secret';
  assert.throws(() => validateConfig(input), /CONFIG_INVALID/);
  input.actual.bases['financa-hml2'].passwordRef = 'actual-password';
  input.gemini.apiKeyRef = 'gemini-key';
  const config = validateConfig(input);
  assert.deepEqual(actualSecretReferences(config), ['actual-password']);
});

test('compatibility leaf fields update only the default profile for the legacy setup wizard', () => {
  const input = multi();
  input.actual.serverURL = 'http://localhost:5010';
  input.actual.budgetId = 'replacement-default';
  input.actual.passwordRef = 'replacement-password';
  input.actual.encryptionPasswordRef = null;
  const config = validateConfig(input);
  assert.equal(config.actual.bases.principal.serverURL, 'http://localhost:5010');
  assert.equal(config.actual.bases.principal.budgetId, 'replacement-default');
  assert.equal(config.actual.bases['financa-hml2'].budgetId, 'hml-budget');
});
