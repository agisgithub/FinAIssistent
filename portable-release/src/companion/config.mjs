import { badConfig } from '../config-diagnostics.mjs';

export function validateCompanionConfig(input = {}) {
  const defaults = { enabled: true, transactionMonitorEnabled: false, autoCategorizeHighConfidence: false, memoryDefaultTtlDays: 180, maxContextMemories: 12, maxContextGoals: 8, maxContextChars: 4000 };
  if (!input || typeof input !== 'object' || Array.isArray(input)) badConfig('companion', 'expected_object');
  if (Object.keys(input).some(key => !Object.hasOwn(defaults, key))) badConfig('companion', 'unknown_field');
  const value = { ...defaults, ...input };
  for (const key of ['enabled','transactionMonitorEnabled','autoCategorizeHighConfidence']) if (typeof value[key] !== 'boolean') badConfig(`companion.${key}`, 'expected_boolean');
  if (value.autoCategorizeHighConfidence && !value.transactionMonitorEnabled) badConfig('companion.autoCategorizeHighConfidence', 'monitor_required');
  for (const [key, min, max] of [['memoryDefaultTtlDays',1,3650],['maxContextMemories',1,50],['maxContextGoals',1,50],['maxContextChars',512,12000]]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) badConfig(`companion.${key}`, 'integer_out_of_range');
  }
  return Object.freeze(value);
}
