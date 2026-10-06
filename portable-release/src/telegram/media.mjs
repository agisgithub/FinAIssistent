import { AppError } from '../errors.mjs';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

function filename(value) {
  if (typeof value !== 'string' || value.length < 5 || value.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(value)) throw new AppError('INPUT_INVALID');
  return value;
}

function png(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length <= PNG_SIGNATURE.length || bytes.length > MAX_PHOTO_BYTES || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new AppError('INPUT_INVALID');
  return bytes;
}

export function encodePngPhoto(bytes, name = 'grafico.png') {
  return { type: 'image/png', filename: filename(name), data: png(bytes).toString('base64') };
}

export function decodePngPhoto(photo) {
  if (!photo || typeof photo !== 'object' || Array.isArray(photo) || Object.keys(photo).length !== 3 || photo.type !== 'image/png') throw new AppError('INPUT_INVALID');
  filename(photo.filename);
  if (typeof photo.data !== 'string' || photo.data.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(photo.data)) throw new AppError('INPUT_INVALID');
  const bytes = png(Buffer.from(photo.data, 'base64'));
  if (bytes.toString('base64') !== photo.data) throw new AppError('INPUT_INVALID');
  return { bytes, filename: photo.filename, type: photo.type };
}
