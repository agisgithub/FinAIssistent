import { ERROR_CODES } from '../errors.mjs';
import { safeConfigLogFields } from '../config-diagnostics.mjs';
const events = new Set(['started', 'stopped', 'startup_failed', 'poll_failed', 'job_failed', 'delivery_failed', 'actual_failed']);
const integrations = new Set(['actual', 'telegram', 'storage']);
export function createLogger(write = line => process.stdout.write(line + '\n')) {
  return (event, fields = {}) => {
    const record = { at: new Date().toISOString(), event: events.has(event) ? event : 'job_failed' };
    if (ERROR_CODES.has(fields.code)) record.code = fields.code;
    if (event === 'startup_failed' && fields.code === 'CONFIG_INVALID') Object.assign(record, safeConfigLogFields(fields));
    if (integrations.has(fields.integration)) record.integration = fields.integration;
    if (Number.isSafeInteger(fields.durationMs) && fields.durationMs >= 0) record.durationMs = fields.durationMs;
    // Opaque internal UUIDs only, never an arbitrary string supplied by an integration.
    for (const key of ['jobId', 'operationId']) {
      if (typeof fields[key] === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(fields[key])) record[key] = fields[key];
    }
    write(JSON.stringify(record));
  };
}
