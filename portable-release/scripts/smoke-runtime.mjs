// CI-only synthetic smoke of the shipping image. No production config or secrets.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const image = process.argv[2] ?? 'finaissistent:ci';
const parent = tmpdir(), root = mkdtempSync(path.join(parent, 'finaissistent-runtime-'));
const run = args => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 1048576 });
  assert.ifError(result.error);
  return result;
};
// A real Linux PTY exercises readline masking and terminal cancellation. The
// synthetic secrets are supplied only after the matching prompt is visible.
async function wizardPty(args, cancel) {
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  const child = spawn('script', ['-q', '-e', '-c', ['docker', ...args].map(quote).join(' '), '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', step = 0;
  const prompts = [
    ['URL do Actual acessível pelo container', '\r'], ['Sync ID do orçamento Actual', '\r'],
    ['Token Telegram', '987:PTY_CANARY_TOKEN\r'], ['Senha do servidor Actual', '  PTY_CANARY_PASSWORD  \r'],
    ['O orçamento Actual usa senha de criptografia', '\r'],
    ...(cancel ? [['Envie /start', cancel]] : [
      ['Envie /start', '\r'], ['Seu userId Telegram (número)', '123\r'], ['Seu chatId privado (número)', '\r'],
      ['Confirma que esses IDs pertencem ao SEU chat privado?', 's\r'], ['Ativar interpretação pelo Ollama local?', '\r'],
      ['Permitir escrita real de categorias no Actual após confirmação?', '\r'], ['Salvar esta configuração e os segredos?', 's\r']
    ])
  ];
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  child.stdout.on('data', bytes => {
    output += bytes.toString();
    if (step < prompts.length && output.includes(prompts[step][0])) child.stdin.write(prompts[step++][1]);
  });
  child.stderr.on('data', bytes => { output += bytes.toString(); });
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timer);
  assert.equal(step, prompts.length, 'Wizard PTY did not complete its prompts');
  assert.equal(status, cancel ? 3 : 0, 'Wizard PTY did not finish with its expected status');
  assert.doesNotMatch(output, /PTY_CANARY/);
  assert.match(output, cancel ? /Configuração cancelada/ : /Configuração salva/);
}
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
  config.dataDir = '/data'; config.secretDir = '/run/secrets'; config.actual.budgetId = 'synthetic-budget';
  assert.equal(fixtureWrite(config).status, 0);
  const wizardArgs = ['run', '--rm', '-it', '--init', '--network', 'none', '--read-only', '--user', '0:0',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE', '--security-opt', 'no-new-privileges:true',
    '--mount', `type=bind,source=${root},target=/setup`, image, 'node', 'scripts/setup-docker.mjs'];
  await wizardPty(wizardArgs, '\x03');
  await wizardPty(wizardArgs, '\x04');
  const unchanged = run(['run', '--rm', '--network', 'none', '--user', '0:0', '--mount', `type=bind,source=${root},target=/setup`, image,
    'node', '-e', "const f=require('node:fs');if(f.existsSync('/setup/.setup-private')||f.readFileSync('/setup/config.json','utf8')!==process.argv[1]||f.readFileSync('/setup/secrets/telegram-token','utf8')!=='123:SYNTHETIC_CANARY_TOKEN'||f.readFileSync('/setup/secrets/actual-password','utf8')!=='SYNTHETIC_CANARY_PASSWORD')process.exit(1)", JSON.stringify(config)]);
  assert.equal(unchanged.status, 0, 'Cancelled wizard changed configuration/secrets or left staging');
  await wizardPty(wizardArgs, null);
  const saved = run(['run', '--rm', '--network', 'none', '--user', '0:0', '--mount', `type=bind,source=${root},target=/setup`, image,
    'node', '-e', "const fs=require('node:fs'),assert=require('node:assert/strict');for(const name of ['config.json','secrets/telegram-token','secrets/actual-password']){const s=fs.statSync('/setup/'+name);assert.equal(s.uid,1000);assert.equal(s.gid,1000);assert.equal(s.mode&0o777,0o600)}const s=fs.statSync('/setup/secrets');assert.equal(s.uid,1000);assert.equal(s.gid,1000);assert.equal(s.mode&0o777,0o700);const dirs=fs.readdirSync('/setup/.setup-private/backups');assert.equal(dirs.length,1);const backup='/setup/.setup-private/backups/'+dirs[0];assert.equal(fs.readFileSync(backup+'/config.json','utf8'),process.argv[1]);assert.equal(fs.readFileSync(backup+'/secret-telegram-token','utf8'),'123:SYNTHETIC_CANARY_TOKEN');assert.equal(fs.readFileSync(backup+'/secret-actual-password','utf8'),'SYNTHETIC_CANARY_PASSWORD');assert.equal(fs.readFileSync('/setup/secrets/actual-password','utf8'),'  PTY_CANARY_PASSWORD  \\n');assert.equal(fs.statSync('/setup/.setup-private').mode&0o777,0o700);assert.deepEqual(fs.readdirSync('/setup/.setup-private'),['backups']);", JSON.stringify(config)]);
  assert.equal(saved.status, 0, 'Saved wizard ownership, modes, secret spacing or backups were incorrect');
  const provisioned = run([...common, image, 'node', 'scripts/preflight.mjs']);
  assert.equal(provisioned.status, 0, 'UID 1000 preflight rejected the files provisioned by the wizard');
  assert.match(provisioned.stdout, /"event":"preflight_ok"/);
  assert.doesNotMatch(provisioned.stdout + provisioned.stderr, /CANARY/);
  const checkFiles = run([...common, image, 'node', '-e', "const f=require('node:fs'); if(f.readdirSync('/data').some(n=>n!=='actual')||f.readdirSync('/data/actual').length)process.exit(1)"]);
  assert.equal(checkFiles.status, 0, 'Preflight left files or touched financial storage');
  console.log('Runtime Docker smoke passed: offline preflight, UID 1000, read-only root, safe startup errors, masked wizard PTY cancel/EOF/save, private backups, no financial writes.');
} finally {
  const relative = path.relative(parent, path.resolve(root));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe synthetic cleanup target');
  // Confined synthetic cleanup also covers a failed root-owned wizard staging
  // directory; the original mkdtemp root remains owned by the host runner.
  run(['run', '--rm', '--network', 'none', '--user', '0:0', '--mount', `type=bind,source=${root},target=/fixture`, image, 'node', '-e',
    "const fs=require('node:fs');for(const name of fs.readdirSync('/fixture'))fs.rmSync('/fixture/'+name,{recursive:true,force:true});"]);
  rmdirSync(root);
}
