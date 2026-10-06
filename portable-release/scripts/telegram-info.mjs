import { telegramSetupInfo } from '../src/telegram/setup-info.mjs';

if (process.argv.length > 4 || process.argv.slice(2).some(value => value.startsWith('-'))) {
  console.log(JSON.stringify({ event: 'telegram_info_failed', reason: 'usage_node_scripts_telegram_info_optional_secret_dir_token_ref' }));
  process.exitCode = 2;
} else {
  const result = await telegramSetupInfo({ secretDir: process.argv[2], tokenRef: process.argv[3] });
  console.log(JSON.stringify(result));
  process.exitCode = result.event === 'telegram_info_ok' ? 0 : 1;
}
