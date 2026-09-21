import { badConfig } from '../config-diagnostics.mjs';

export function validateCompanionConfig(input = {}) {
  const defaults = { enabled: true, memoryDefaultTtlDays: 180, maxContextMemories: 12, maxContextGoals: 8, maxContextChars: 4000 };
  if (!input || typeof input !== 'object' || Array.isArray(input)) badConfig('companion', 'expected_object');
  if (Object.keys(input).some(key => !Object.hasOwn(defaults, key))) badConfig('companion', 'unknown_field');
  const value = { ...defaults, ...input };
  if (typeof value.enabled !== 'boolean') badConfig('companion.enabled', 'expected_boolean');
  for (const [key, min, max] of [['memoryDefaultTtlDays',1,3650],['maxContextMemories',1,50],['maxContextGoals',1,50],['maxContextChars',512,12000]]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < min || value[key] > max) badConfig(`companion.${key}`, 'integer_out_of_range');
  }
  return Object.freeze(value);
}
