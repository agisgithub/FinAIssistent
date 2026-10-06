import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const files = readdirSync('src', { recursive: true }).filter(name => name.endsWith('.mjs'));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join('src', file)], { stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(1);
}
console.log(`Syntax checked: ${files.length} modules.`);
