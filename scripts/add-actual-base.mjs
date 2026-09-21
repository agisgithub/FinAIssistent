import { addActualBase } from '../src/setup/actual-base.mjs';

process.umask(0o077);
const args = process.argv.slice(2), allowed = new Set(['--config','--source','--alias','--server-url']);
const values = {};
let valid = args.length === 8;
for (let index = 0; valid && index < args.length; index += 2) {
  const name = args[index], value = args[index + 1];
  if (!allowed.has(name) || typeof value !== 'string' || !value || Object.hasOwn(values, name)) valid = false;
  else values[name] = value;
}
if (!valid || [...allowed].some(name => !Object.hasOwn(values, name))) {
  process.stdout.write(JSON.stringify({ event: 'actual_base_config_failed', reason: 'usage' }) + '\n');
  process.exitCode = 2;
} else {
  try {
    const result = await addActualBase({ configFile: values['--config'], sourceFile: values['--source'], alias: values['--alias'], serverURL: values['--server-url'] });
    process.stdout.write(JSON.stringify({ event: 'actual_base_config_ok', status: result.status, alias: result.alias }) + '\n');
  } catch (error) {
    const allowedReasons = new Set(['file_unavailable','unsafe_file','invalid_json','budget_id_unavailable','invalid_arguments','target_config_invalid','alias_conflict','result_config_invalid','target_changed','atomic_write_failed']);
    process.stdout.write(JSON.stringify({ event: 'actual_base_config_failed', reason: allowedReasons.has(error?.reason) ? error.reason : 'internal' }) + '\n');
    process.exitCode = 1;
  }
}
