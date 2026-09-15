import { isIP } from 'node:net';
import { badConfig } from '../config-diagnostics.mjs';

const bad = (field, reason) => badConfig('ollama' + (field ? '.' + field : ''), reason);
export const cloudName = name => typeof name === 'string' && /(^|[-:/.])cloud($|[-:/.])/i.test(name);
const privateAddress = host => {
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return isIP(host) === 6 && /^(fc|fd)/i.test(host);
};
export function validateOllamaConfig(input = {}) {
  const keys = ['enabled', 'url', 'model', 'localOnlyConfirmed', 'allowPrivateAddress', 'timeoutMs', 'maxInputBytes', 'maxResponseBytes', 'contextTokens', 'outputTokens'];
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('', 'expected_object');
  if (Object.keys(input).some(key => !keys.includes(key))) bad('', 'unknown_field');
  const value = { enabled: false, url: 'http://127.0.0.1:11434', model: null, localOnlyConfirmed: false, allowPrivateAddress: false, timeoutMs: 30000, maxInputBytes: 4096, maxResponseBytes: 131072, contextTokens: 8192, outputTokens: 256, ...input };
  for (const key of ['enabled', 'localOnlyConfirmed', 'allowPrivateAddress']) if (typeof value[key] !== 'boolean') bad(key, 'expected_boolean');
  if (value.enabled && !value.localOnlyConfirmed) bad('localOnlyConfirmed', 'local_confirmation_required');
  if (value.enabled && !value.model) bad('model', 'local_model_required');
  if (value.model !== null && (typeof value.model !== 'string' || value.model.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(value.model) || value.model.includes('..') || cloudName(value.model))) bad('model', 'invalid_local_model');
  let url;
  if (typeof value.url !== 'string') bad('url', 'invalid_url');
  try { url = new URL(value.url); } catch { bad('url', 'invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') bad('url', 'unsafe_url');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127');
  if (!loopback && host !== 'host.docker.internal' && !(value.allowPrivateAddress && privateAddress(host))) bad('url', 'local_address_required');
  for (const [key, min, max] of [['timeoutMs', 1000, 120000], ['maxInputBytes', 64, 4096], ['maxResponseBytes', 1024, 1048576], ['contextTokens', 4096, 32768], ['outputTokens', 64, 1024]]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) bad(key, 'integer_out_of_range');
  }
  return Object.freeze({ ...value, url: url.origin });
}
