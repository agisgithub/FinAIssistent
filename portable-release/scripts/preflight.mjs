import { preflight } from '../src/preflight.mjs';

process.umask(0o077);
if (process.argv.length > 3 || process.argv[2]?.startsWith('-')) {
  console.log(JSON.stringify({ event: 'preflight_failed', reason: 'usage_node_scripts_preflight_optional_config_file' }));
  process.exitCode = 2;
} else {
  try {
    const result = await preflight(process.argv[2]);
    for (const check of result.checks) console.log(JSON.stringify(check));
    console.log(JSON.stringify({ event: result.ok ? 'preflight_ok' : 'preflight_failed', network: 'not_checked' }));
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ event: 'preflight_failed', reason: 'internal_check_failed' }));
    process.exitCode = 1;
  }
}
