import { AppError } from '../errors.mjs';
export const defaultBillPolicy = timezone => ({ revision:1, since:null, timezone, time:'08:00', remindersEnabled:false, days:[7,3,1], variationEnabled:false, variationPercent:20, variationMinimumCents:2000 });
export function validateBillPolicy(value,timezone) {
  const keys=Object.keys(defaultBillPolicy(timezone));
  if (!value||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(value,k))) throw new AppError('INPUT_INVALID');
  if (value.timezone!==timezone||!Number.isSafeInteger(value.revision)||value.revision<1||typeof value.remindersEnabled!=='boolean'||typeof value.variationEnabled!=='boolean'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)||!Array.isArray(value.days)||!value.days.length||value.days.length>12||new Set(value.days).size!==value.days.length||value.days.some(n=>!Number.isInteger(n)||n<0||n>90)||!Number.isInteger(value.variationPercent)||value.variationPercent<1||value.variationPercent>1000||!Number.isSafeInteger(value.variationMinimumCents)||value.variationMinimumCents<0||(value.since!==null&&(!Number.isSafeInteger(value.since)||value.since<0))) throw new AppError('INPUT_INVALID');
  return {...value,days:[...value.days].sort((a,b)=>b-a)};
}
