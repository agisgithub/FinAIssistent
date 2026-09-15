// CI-only synthetic smoke of the shipping image. No production config or secrets.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const image = process.argv[2] ?? 'finaissistent:ci';
const parent = tmpdir(), root = mkdtempSync(path.join(parent, 'finaissistent-runtime-'));
const run = args => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 1048576 });
  assert.ifError(result.error);
  return result;
};
const config = JSON.parse(readFileSync(new URL('../config.docker.example.json', import.meta.url), 'utf8'));
config.actual.budgetId = 'synthetic-budget';
const configFile = path.join(root, 'config.json'), secrets = path.join(root, 'secrets'), data = path.join(root, 'data');
mkdirSync(secrets); mkdirSync(data); mkdirSync(path.join(data, 'actual'));
writeFileSync(configFile, JSON.stringify(config));
writeFileSync(path.join(secrets, 'telegram-token'), '123:SYNTHETIC_CANARY_TOKEN');
writeFileSync(path.join(secrets, 'actual-password'), 'SYNTHETIC_CANARY_PASSWORD');
const common = ['run', '--rm', '--network', 'none', '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
  '--mount', `type=bind,source=${configFile},target=/app/config.json,readonly`,
  '--mount', `type=bind,source=${secrets},target=/run/secrets,readonly`,
  '--mount', `type=bind,source=${data},target=/data`];
try {
  const prepare = run(['run', '--rm', '--network', 'none', '--user', '0:0', '--mount', `type=bind,source=${root},target=/fixture`, image, 'node', '-e',
    "const fs=require('node:fs'); function prepare(p){const s=fs.lstatSync(p);fs.chownSync(p,1000,1000);fs.chmodSync(p,s.isDirectory()?0o700:0o600);if(s.isDirectory())for(const n of fs.readdirSync(p))prepare(p+'/'+n)}fs.chmodSync('/fixture',0o777);for(const name of fs.readdirSync('/fixture'))prepare('/fixture/'+name);"]);
  assert.equal(prepare.status, 0, 'Synthetic fixture preparation failed');
  const good = run([...common, image, 'node', 'scripts/preflight.mjs']);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /"event":"preflight_ok"/);
  assert.doesNotMatch(good.stdout + good.stderr, /CANARY/);
  // Relative Node paths must fail on the shipping read-only Docker filesystem.
  config.dataDir = './data'; config.secretDir = './secrets';
  const fixtureWrite = value => run(['run', '--rm', '--network', 'none', '--user', '1000:1000', '--mount', `type=bind,source=${root},target=/fixture`, image,
    'node', '-e', "require('node:fs').writeFileSync('/fixture/config.json',process.argv[1]);", JSON.stringify(value)]);
  assert.equal(fixtureWrite(config).status, 0);
  const wrongPaths = run([...common, image, 'node', 'scripts/preflight.mjs']);
  assert.equal(wrongPaths.status, 1);
  assert.match(wrongPaths.stdout, /"field":"dataDir","status":"failed"/);
  config.actual.budgetId = 'REPLACE_SYNTHETIC_CANARY';
  assert.equal(fixtureWrite(config).status, 0);
  const invalid = run([...common, image, 'node', 'src/main.mjs']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /"configField":"actual.budgetId","configReason":"replace_placeholder"/);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /CANARY/);
  // The helper is shipped too; network:none must produce a bounded safe error.
  const telegram = run([...common, image, 'node', 'scripts/telegram-info.mjs']);
  assert.equal(telegram.status, 1);
  assert.match(telegram.stdout, /"event":"telegram_info_failed"/);
  assert.doesNotMatch(telegram.stdout + telegram.stderr, /CANARY/);
  const checkFiles = run([...common, image, 'node', '-e', "const f=require('node:fs'); if(f.readdirSync('/data').some(n=>n!=='actual')||f.readdirSync('/data/actual').length)process.exit(1)"]);
  assert.equal(checkFiles.status, 0, 'Preflight left files or touched financial storage');
  console.log('Runtime Docker smoke passed: offline preflight, UID 1000, read-only root, safe startup errors, no financial writes.');
} finally {
  const relative = path.relative(parent, path.resolve(root));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe synthetic cleanup target');
  // The fixture is owned by container UID 1000. Remove its children as that UID,
  // then remove the original mkdtemp root from its host-owned temporary parent.
  run(['run', '--rm', '--network', 'none', '--user', '1000:1000', '--mount', `type=bind,source=${root},target=/fixture`, image, 'node', '-e',
    "const fs=require('node:fs');for(const name of fs.readdirSync('/fixture'))fs.rmSync('/fixture/'+name,{recursive:true,force:true});"]);
  rmdirSync(root);
}
