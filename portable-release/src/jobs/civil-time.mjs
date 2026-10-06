import { AppError } from '../errors.mjs';
import { validDate } from '../actual/snapshot.mjs';

const formatters = new Map();
function parts(instant, timezone) {
  if (!formatters.has(timezone)) formatters.set(timezone,new Intl.DateTimeFormat('en-CA',{ timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' }));
  const values = Object.fromEntries(formatters.get(timezone).formatToParts(new Date(instant)).map(p => [p.type,p.value]));
  return { date:`${values.year}-${values.month}-${values.day}`, time:`${values.hour}:${values.minute}` };
}
export function civilParts(instant, timezone) { return parts(instant,timezone); }
export function addCivilDays(date, days) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate()+days); return value.toISOString().slice(0,10); }

export function resolveCivilTime(date, time, timezone) {
  if (!validDate(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new AppError('INPUT_INVALID');
  const naive = Date.parse(`${date}T${time}:00Z`), offsets = new Set();
  for (const hours of [-36,-24,-12,0,12,24,36]) {
    const instant = naive+hours*3600000, local = parts(instant,timezone);
    offsets.add(Date.parse(`${local.date}T${local.time}:00Z`)-instant);
  }
  const candidates = civil => [...offsets].map(offset => civil-offset).filter(instant => { const local = parts(instant,timezone); return `${local.date}T${local.time}:00Z` === new Date(civil).toISOString().replace('.000',''); });
  // Fold: first instant only. Gap: first valid civil minute at/after requested
  // time on the same date. A whole skipped civil date has no occurrence.
  for (let civil = naive; new Date(civil).toISOString().slice(0,10) === date; civil += 60000) {
    const matching = candidates(civil);
    if (matching.length) return { instant: Math.min(...matching), shifted: civil !== naive, civilDate:date, requestedTime:time, effectiveTime:new Date(civil).toISOString().slice(11,16) };
  }
  return null;
}

export function latestDailyOccurrence(preferences, now) {
  if (!preferences.dailyEnabled) return null;
  const currentDate = parts(now,preferences.timezone).date;
  let latest = null;
  for (let ago=0; ago<=14; ago++) {
    const date = addCivilDays(currentDate,-ago), weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
    if (!preferences.days.includes(weekday)) continue;
    const slot = resolveCivilTime(date,preferences.time,preferences.timezone);
    if (slot && slot.instant<=now && slot.instant>=preferences.dailySince && (!latest || slot.instant>latest.instant)) latest=slot;
  }
  return latest;
}
