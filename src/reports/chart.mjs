import { PNG } from 'pngjs';
import { AppError } from '../errors.mjs';
import { formatMoney } from '../finance/money.mjs';
import { safeLabel } from './render.mjs';

const WIDTH = 1200, HEIGHT = 675, MAX_PNG_BYTES = 2 * 1024 * 1024;
const COLORS = Object.freeze({ background: [248, 250, 252, 255], ink: [28, 37, 54, 255], muted: [85, 101, 124, 255], grid: [211, 220, 232, 255], blue: [34, 112, 210, 255], orange: [220, 104, 45, 255], white: [255, 255, 255, 255] });
const FONT = Object.freeze({
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
  A: ['01110','10001','10001','11111','10001','10001','10001'], B: ['11110','10001','10001','11110','10001','10001','11110'], C: ['01111','10000','10000','10000','10000','10000','01111'], D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'], F: ['11111','10000','10000','11110','10000','10000','10000'], G: ['01111','10000','10000','10111','10001','10001','01111'], H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'], J: ['00111','00010','00010','00010','10010','10010','01100'], K: ['10001','10010','10100','11000','10100','10010','10001'], L: ['10000','10000','10000','10000','10000','10000','11111'],
  M: ['10001','11011','10101','10101','10001','10001','10001'], N: ['10001','11001','10101','10011','10001','10001','10001'], O: ['01110','10001','10001','10001','10001','10001','01110'], P: ['11110','10001','10001','11110','10000','10000','10000'],
  Q: ['01110','10001','10001','10001','10101','10010','01101'], R: ['11110','10001','10001','11110','10100','10010','10001'], S: ['01111','10000','10000','01110','00001','00001','11110'], T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'], V: ['10001','10001','10001','10001','10001','01010','00100'], W: ['10001','10001','10001','10101','10101','10101','01010'], X: ['10001','10001','01010','00100','01010','10001','10001'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'], Z: ['11111','00001','00010','00100','01000','10000','11111'],
  0: ['01110','10001','10011','10101','11001','10001','01110'], 1: ['00100','01100','00100','00100','00100','00100','01110'], 2: ['01110','10001','00001','00010','00100','01000','11111'], 3: ['11110','00001','00001','01110','00001','00001','11110'],
  4: ['00010','00110','01010','10010','11111','00010','00010'], 5: ['11111','10000','10000','11110','00001','00001','11110'], 6: ['01110','10000','10000','11110','10001','10001','01110'], 7: ['11111','00001','00010','00100','01000','01000','01000'],
  8: ['01110','10001','10001','01110','10001','10001','01110'], 9: ['01110','10001','10001','01111','00001','00001','01110'],
  '-': ['00000','00000','00000','11111','00000','00000','00000'], '/': ['00001','00010','00100','01000','10000','00000','00000'], '.': ['00000','00000','00000','00000','00000','01100','01100'], ',': ['00000','00000','00000','00000','00100','00100','01000'],
  ':': ['00000','01100','01100','00000','01100','01100','00000'], '|': ['00100','00100','00100','00100','00100','00100','00100'], '$': ['00100','01111','10100','01110','00101','11110','00100'], '+': ['00000','00100','00100','11111','00100','00100','00000'], '?': ['01110','10001','00010','00100','00100','00000','00100']
});
const MONTHS = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];

const ascii = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 /.,:|$+?-]/g, '?');
const textWidth = (value, scale) => Math.max(0, ascii(value).length * 6 * scale - scale);
function pixel(png, x, y, color) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const index = (Math.floor(y) * png.width + Math.floor(x)) * 4;
  png.data.set(color, index);
}
function rectangle(png, x, y, width, height, color) {
  const left = Math.max(0, Math.floor(x)), top = Math.max(0, Math.floor(y)), right = Math.min(png.width, Math.ceil(x + width)), bottom = Math.min(png.height, Math.ceil(y + height));
  for (let row = top; row < bottom; row++) for (let column = left; column < right; column++) pixel(png, column, row, color);
}
function line(png, x0, y0, x1, y1, color, thickness = 1) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1; let error = dx + dy;
  while (true) {
    rectangle(png, x0 - Math.floor(thickness / 2), y0 - Math.floor(thickness / 2), thickness, thickness, color);
    if (x0 === x1 && y0 === y1) break;
    const twice = 2 * error; if (twice >= dy) { error += dy; x0 += sx; } if (twice <= dx) { error += dx; y0 += sy; }
  }
}
function text(png, value, x, y, scale = 2, color = COLORS.ink) {
  let cursor = Math.round(x);
  for (const character of ascii(value)) {
    const glyph = FONT[character] ?? FONT['?'];
    for (let row = 0; row < 7; row++) for (let column = 0; column < 5; column++) if (glyph[row][column] === '1') rectangle(png, cursor + column * scale, y + row * scale, scale, scale, color);
    cursor += 6 * scale;
  }
}
const centeredText = (png, value, center, y, scale, color) => text(png, value, center - textWidth(value, scale) / 2, y, scale, color);
const monthLabel = month => `${MONTHS[Number(month.slice(5, 7)) - 1]}/${month.slice(2, 4)}`;
function compactMoney(cents, withCurrency = true) {
  const sign = cents < 0 ? '-' : '', value = Math.abs(cents) / 100;
  let body;
  if (value >= 1_000_000) body = `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1).replace('.', ',')}M`;
  else if (value >= 1_000) body = `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1).replace('.', ',')}K`;
  else body = value.toFixed(value < 10 && value % 1 ? 1 : 0).replace('.', ',');
  return `${sign}${withCurrency ? 'R$' : ''}${body}`;
}
function niceBound(value) {
  if (value <= 0) return 100;
  const power = 10 ** Math.floor(Math.log10(value)), normalized = value / power;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * power;
}
function assertSeries(series, chartType) {
  if (!series || series.status !== 'ok' || series.currency !== 'BRL' || !Array.isArray(series.months) || series.months.length < 1 || series.months.length > 24 || !['bar','line'].includes(chartType)) throw new AppError('INPUT_INVALID');
  if (series.months.some(row => !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month) || !Number.isSafeInteger(row.netCents))) throw new AppError('SNAPSHOT_INVALID');
}

export function renderMonthlySpendingChart(series, { chartType = 'bar' } = {}) {
  assertSeries(series, chartType);
  const png = new PNG({ width: WIDTH, height: HEIGHT }); rectangle(png, 0, 0, WIDTH, HEIGHT, COLORS.background);
  const category = ascii(safeLabel(series.category?.name, 34)), group = ascii(safeLabel(series.category?.groupName, 24));
  text(png, 'GASTOS MENSAIS', 48, 28, 4, COLORS.ink);
  text(png, `${category}${group ? ` - ${group}` : ''}`, 48, 68, 3, COLORS.blue);
  text(png, `${monthLabel(series.months[0].month)} A ${monthLabel(series.months.at(-1).month)} | GASTO LIQUIDO EM BRL`, 48, 96, 2, COLORS.muted);
  const plot = { left: 130, right: 1160, top: 140, bottom: 525 }, values = series.months.map(row => row.netCents);
  const max = niceBound(Math.max(0, ...values)), min = Math.min(0, ...values) < 0 ? -niceBound(Math.abs(Math.min(...values))) : 0, span = max - min;
  const y = value => plot.bottom - (value - min) / span * (plot.bottom - plot.top), zero = y(0);
  for (let index = 0; index <= 4; index++) {
    const value = min + span * index / 4, rowY = y(value);
    line(png, plot.left, rowY, plot.right, rowY, index === 0 && min === 0 ? COLORS.muted : COLORS.grid, index === 0 && min === 0 ? 2 : 1);
    const label = compactMoney(Math.round(value)); text(png, label, plot.left - textWidth(label, 2) - 14, rowY - 7, 2, COLORS.muted);
  }
  const slot = (plot.right - plot.left) / series.months.length, points = [];
  series.months.forEach((row, index) => {
    const center = plot.left + slot * (index + 0.5), valueY = y(row.netCents), color = row.netCents < 0 ? COLORS.orange : COLORS.blue;
    if (chartType === 'bar') {
      const width = Math.max(10, Math.min(56, slot * 0.62)), top = Math.min(valueY, zero), height = Math.max(2, Math.abs(zero - valueY));
      rectangle(png, center - width / 2, top, width, height, color);
    } else points.push({ x: center, y: valueY, color });
    centeredText(png, compactMoney(row.netCents, false), center, Math.max(plot.top + 2, row.netCents < 0 ? valueY + 8 : valueY - 17), 1, color);
    centeredText(png, monthLabel(row.month), center, plot.bottom + 18, 1, COLORS.ink);
  });
  if (chartType === 'line') {
    for (let index = 1; index < points.length; index++) line(png, points[index - 1].x, points[index - 1].y, points[index].x, points[index].y, COLORS.blue, 4);
    for (const point of points) rectangle(png, point.x - 5, point.y - 5, 11, 11, point.color);
  }
  const footer = `TOTAL ${compactMoney(series.totals.netCents)} | MEDIA ${compactMoney(series.totals.averageNetCents)}`;
  centeredText(png, footer, WIDTH / 2, 585, 3, COLORS.ink);
  centeredText(png, 'AZUL: GASTO LIQUIDO | LARANJA: ESTORNOS SUPERAM GASTOS', WIDTH / 2, 625, 2, COLORS.muted);
  const output = PNG.sync.write(png, { colorType: 6 });
  if (output.length > MAX_PNG_BYTES || !output.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new AppError('INTERNAL_ERROR');
  return output;
}

export function renderMonthlySpendingMessage(series) {
  assertSeries(series, 'bar');
  const category = safeLabel(series.category?.name, 100), group = safeLabel(series.category?.groupName, 100);
  const rows = series.months.map(row => `${monthLabel(row.month).toLowerCase()}  ${formatMoney(row.netCents)}`);
  const excluded = series.excluded?.transfers || series.excluded?.accounts || series.excluded?.parents
    ? `Fora do total: ${series.excluded.transfers ?? 0} transferência(s), ${series.excluded.parents ?? 0} pai(s) de divisão e ${series.excluded.accounts ?? 0} movimento(s) fora do escopo.` : '';
  return [`📊 ${category}${group ? ` · ${group}` : ''}`, ...rows, `Total ${formatMoney(series.totals.netCents)} · média mensal ${formatMoney(series.totals.averageNetCents)}${excluded ? ` · ${excluded}` : ''}`].join('\n');
}

export const CHART_LIMITS = Object.freeze({ width: WIDTH, height: HEIGHT, maxPngBytes: MAX_PNG_BYTES });
