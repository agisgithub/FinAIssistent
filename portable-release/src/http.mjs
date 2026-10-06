import { AppError } from './errors.mjs';
export async function readJsonLimited(response, maxBytes = 4194304) {
  const declared = response.headers?.get('content-length');
  if (declared && Number(declared) > maxBytes) throw new AppError('NETWORK_FAILED');
  if (!response.body) throw new AppError('NETWORK_FAILED');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new AppError('NETWORK_FAILED');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('NETWORK_FAILED'); }
}
