import { isIP } from 'node:net';
import { AppError } from '../errors.mjs';

const bad = () => { throw new AppError('CONFIG_INVALID'); };
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
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) bad();
  const value = { enabled: false, url: 'http://127.0.0.1:11434', model: null, localOnlyConfirmed: false, allowPrivateAddress: false, timeoutMs: 30000, maxInputBytes: 4096, maxResponseBytes: 131072, contextTokens: 8192, outputTokens: 256, ...input };
  if (['enabled', 'localOnlyConfirmed', 'allowPrivateAddress'].some(key => typeof value[key] !== 'boolean')) bad();
  if (value.enabled && (!value.localOnlyConfirmed || !value.model)) bad();
  if (value.model !== null && (typeof value.model !== 'string' || value.model.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(value.model) || value.model.includes('..') || cloudName(value.model))) bad();
  let url;
  try { url = new URL(value.url); } catch { bad(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') bad();
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127');
  if (!loopback && host !== 'host.docker.internal' && !(value.allowPrivateAddress && privateAddress(host))) bad();
  for (const [key, min, max] of [['timeoutMs', 1000, 120000], ['maxInputBytes', 64, 4096], ['maxResponseBytes', 1024, 1048576], ['contextTokens', 4096, 32768], ['outputTokens', 64, 1024]]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) bad();
  }
  return Object.freeze({ ...value, url: url.origin });
}
