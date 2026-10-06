import { AppError } from '../errors.mjs';
import { cloudName } from './config.mjs';

export const canonicalModel = name => name.includes(':') ? name : `${name}:latest`;
export const isRemoteModel = value => value?.remote_host != null && value.remote_host !== '' || value?.remote_model != null && value.remote_model !== '';
export function safeLocalEntry(item) {
  const name = item?.model ?? item?.name;
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(name) && name.length <= 160 && !name.includes('..')
    && !isRemoteModel(item) && !cloudName(item.model) && !cloudName(item.name) && item.details?.format === 'gguf'
    && Number.isSafeInteger(item.size) && item.size > 0 && /^[a-f0-9]{64}$/i.test(item.digest ?? '');
}
export function localModelInfo(info, contextTokens, { tools = false } = {}) {
  const architecture = info?.model_info?.['general.architecture'];
  if (isRemoteModel(info) || cloudName(info?.details?.parent_model) || info?.details?.format !== 'gguf' || !Array.isArray(info.capabilities)
      || !info.capabilities.includes('completion') || tools && !info.capabilities.includes('tools') || typeof architecture !== 'string' || !architecture) throw new AppError('OLLAMA_MODEL_UNSAFE');
  const capacity = info.model_info?.[`${architecture}.context_length`] ?? info.details?.context_length;
  if (!Number.isSafeInteger(capacity) || capacity < contextTokens) throw new AppError('OLLAMA_MODEL_UNSAFE');
  return { contextTokens: capacity, capabilities: info.capabilities.filter(c => ['completion','tools','thinking','vision','embedding'].includes(c)) };
}
export async function localInventory(request) {
  const result = await request('/api/tags');
  if (!Array.isArray(result.models) || result.models.length > 1000) throw new AppError('OLLAMA_MODEL_UNSAFE');
  return result.models;
}
export async function requireLocalModel(request, model, contextTokens, options) {
  const inventory = await localInventory(request);
  const matches = inventory.filter(item => [item?.model,item?.name].some(n => typeof n === 'string' && canonicalModel(n) === canonicalModel(model)));
  if (matches.length !== 1 || !safeLocalEntry(matches[0])) throw new AppError('OLLAMA_MODEL_UNSAFE');
  return localModelInfo(await request('/api/show', { model, verbose: false }), contextTokens, options);
}
