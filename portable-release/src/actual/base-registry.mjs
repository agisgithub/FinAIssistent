import path from 'node:path';
import { badConfig as bad } from '../config-diagnostics.mjs';

export const DEFAULT_ACTUAL_BASE = 'principal';
export const MAX_ACTUAL_BASES = 16;

const LEAF_KEYS = Object.freeze(['serverURL', 'budgetId', 'passwordRef', 'encryptionPasswordRef', 'timeoutMs']);
const REGISTRY_KEYS = Object.freeze(['defaultBase', 'bases', ...LEAF_KEYS]);
const ALIAS = /^[a-z0-9][a-z0-9_-]*$/;
const SECRET_REF = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const BUDGET_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RESERVED_ALIASES = new Set(['constructor', 'prototype', '__proto__']);

function record(value, keys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad(field, 'expected_object');
  if (Object.keys(value).some(key => !keys.includes(key))) bad(field, 'unknown_field');
}

export function validActualBaseAlias(value) {
  return typeof value === 'string' && value.length <= 32 && ALIAS.test(value) && !RESERVED_ALIASES.has(value);
}

function validateLeaf(input) {
  record(input, LEAF_KEYS, 'actual');
  if (!SECRET_REF.test(input.passwordRef ?? '')) bad('actual.passwordRef', 'invalid_secret_reference');
  if (input.encryptionPasswordRef != null && !SECRET_REF.test(input.encryptionPasswordRef)) bad('actual.encryptionPasswordRef', 'invalid_secret_reference');
  if (typeof input.budgetId === 'string' && input.budgetId.startsWith('REPLACE_')) bad('actual.budgetId', 'replace_placeholder');
  if (typeof input.budgetId !== 'string' || !BUDGET_ID.test(input.budgetId)) bad('actual.budgetId', 'invalid_identifier');
  let url;
  if (typeof input.serverURL !== 'string') bad('actual.serverURL', 'invalid_url');
  try { url = new URL(input.serverURL); } catch { bad('actual.serverURL', 'invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) bad('actual.serverURL', 'unsafe_url');
  const timeoutMs = input.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) bad('actual.timeoutMs', 'integer_out_of_range');
  return Object.freeze({
    serverURL: url.toString().replace(/\/$/, ''),
    budgetId: input.budgetId,
    passwordRef: input.passwordRef,
    encryptionPasswordRef: input.encryptionPasswordRef ?? null,
    timeoutMs
  });
}

function legacyRegistry(input) {
  const profile = validateLeaf(input);
  return Object.freeze({ defaultBase: DEFAULT_ACTUAL_BASE, bases: Object.freeze({ [DEFAULT_ACTUAL_BASE]: profile }) });
}

export function normalizeActualRegistry(input) {
  record(input, REGISTRY_KEYS, 'actual');
  if (!Object.hasOwn(input, 'bases') && !Object.hasOwn(input, 'defaultBase')) return legacyRegistry(input);
  if (!Object.hasOwn(input, 'bases') || !Object.hasOwn(input, 'defaultBase')) bad('actual', 'invalid_identifier');
  if (!validActualBaseAlias(input.defaultBase)) bad('actual', 'invalid_identifier');
  record(input.bases, Object.keys(input.bases), 'actual');
  const entries = Object.entries(input.bases);
  if (entries.length < 1 || entries.length > MAX_ACTUAL_BASES) bad('actual', 'integer_out_of_range');
  if (entries.some(([alias]) => !validActualBaseAlias(alias))) bad('actual', 'invalid_identifier');
  if (!Object.hasOwn(input.bases, DEFAULT_ACTUAL_BASE)) bad('actual', 'invalid_identifier');
  if (!Object.hasOwn(input.bases, input.defaultBase)) bad('actual', 'invalid_identifier');

  // Compatibility fields are allowed on a registry because the Docker setup
  // wizard edits the default profile through the former single-base shape.
  const overrides = Object.fromEntries(LEAF_KEYS.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
  const bases = Object.freeze(Object.fromEntries(entries.map(([alias, value]) => [
    alias,
    validateLeaf(alias === input.defaultBase ? { ...value, ...overrides } : value)
  ])));
  return Object.freeze({ defaultBase: input.defaultBase, bases });
}

export function actualRegistryFromConfig(config) {
  return normalizeActualRegistry(config?.actual);
}

export function actualSecretReferences(registryOrActual) {
  const registry = registryOrActual?.actual ? actualRegistryFromConfig(registryOrActual) : normalizeActualRegistry(registryOrActual);
  return Object.freeze([...new Set(Object.values(registry.bases).flatMap(profile => [profile.passwordRef, profile.encryptionPasswordRef].filter(Boolean)))]);
}

export function actualProfileAliases(config) {
  return Object.freeze(Object.keys(actualRegistryFromConfig(config).bases));
}

export function actualProfileConfig(config, alias) {
  const registry = actualRegistryFromConfig(config);
  if (!validActualBaseAlias(alias) || !Object.hasOwn(registry.bases, alias)) bad('actual', 'invalid_identifier');
  const dataDir = alias === DEFAULT_ACTUAL_BASE ? config.dataDir : path.join(config.dataDir, 'bases', alias);
  return Object.freeze({ ...config, dataDir, actual: registry.bases[alias] });
}

export function actualProfileIdentity(config, alias) {
  const profile = actualProfileConfig(config, alias);
  return Object.freeze({
    baseAlias: alias,
    householdId: profile.householdId,
    budgetId: profile.actual.budgetId,
    userId: profile.telegram.userId,
    chatId: profile.telegram.chatId,
    timezone: profile.timezone,
    currency: profile.currency
  });
}

export function actualProfiles(config) {
  return Object.freeze(actualProfileAliases(config).map(alias => Object.freeze({ alias, config: actualProfileConfig(config, alias), identity: actualProfileIdentity(config, alias) })));
}
