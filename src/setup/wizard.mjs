import * as fs from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { validateConfig } from '../config.mjs';
import { configDiagnostic } from '../config-diagnostics.mjs';
import { telegramSetupInfo } from '../telegram/setup-info.mjs';
import { SetupCancelled } from './terminal.mjs';

const fail = code => { throw new Error(code); };
const reference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const ACTUAL_LEAF_KEYS = Object.freeze(['serverURL', 'budgetId', 'passwordRef', 'encryptionPasswordRef', 'timeoutMs']);
async function entry(filename) { try { return await fs.lstat(filename); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function regular(filename, max = 32768) {
  const stat = await entry(filename);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) fail('SETUP_UNSAFE_FILE');
  return { bytes: await fs.readFile(filename), mode: stat.mode & 0o777, uid: stat.uid, gid: stat.gid };
}
async function directory(filename, { create = false } = {}) {
  const stat = await entry(filename);
  if (!stat && create) { await fs.mkdir(filename, { mode: 0o700 }); return true; }
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('SETUP_UNSAFE_DIRECTORY');
  return false;
}
async function own(filename, owner, mode) {
  if (process.platform !== 'win32') { await fs.chown(filename, owner, owner); await fs.chmod(filename, mode); }
}
function secretValue(record) {
  if (!record) return null;
  const value = record.bytes.toString('utf8').replace(/\r?\n$/, '');
  if (!value || /[\r\n\0]/.test(value) || record.bytes.length > 16384) fail('SETUP_SECRET_FORMAT_INVALID');
  return value;
}
const yes = async (io, prompt, current = false) => {
  for (;;) {
    const answer = (await io.ask(`${prompt} [${current ? 'S/n' : 's/N'}]: `)).trim().toLowerCase();
    if (!answer) return current;
    if (['s', 'sim'].includes(answer)) return true;
    if (['n', 'nao', 'não'].includes(answer)) return false;
    io.write('Responda s ou n.');
  }
};
async function askValue(io, label, current = '') {
  for (;;) {
    const value = (await io.ask(`${label}${current ? ` [${current}]` : ''}: `)).trim() || current;
    if (value) return value;
    io.write('Este campo é obrigatório.');
  }
}
function safeURL(value, fallback) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? url.toString().replace(/\/$/, '') : fallback; }
  catch { return fallback; }
}
// Reused by the AI-only form; it uses the same safe reads and commit protocol.
export const setupFiles = { directory, regular, secretValue, yes, askValue };
function prepareConfig(raw) {
  if (!isObject(raw) || !isObject(raw.telegram) || !isObject(raw.actual) || (raw.ollama != null && !isObject(raw.ollama))) fail('SETUP_CONFIG_STRUCTURE_INVALID');
  const config = structuredClone(raw);
  let actualDefaultBase = null;
  if (Object.hasOwn(config.actual, 'defaultBase') || Object.hasOwn(config.actual, 'bases')) {
    const alias = config.actual.defaultBase, bases = config.actual.bases;
    if (typeof alias !== 'string' || !isObject(bases) || !Object.hasOwn(bases, alias) || !isObject(bases[alias])) fail('SETUP_CONFIG_STRUCTURE_INVALID');
    // Registry configs have one canonical source for each editable value. A
    // compatibility leaf at the registry root is ambiguous and must be fixed
    // manually instead of silently overriding the selected default profile.
    if (ACTUAL_LEAF_KEYS.some(key => Object.hasOwn(config.actual, key))) fail('SETUP_CONFIG_STRUCTURE_INVALID');
    actualDefaultBase = alias;
    config.actual = { ...config.actual, ...structuredClone(bases[alias]) };
  }
  if (config.dataDir != null && !['./data', '/data'].includes(config.dataDir)) fail('SETUP_CUSTOM_DATA_PATH_REQUIRES_MANUAL_SETUP');
  if (config.secretDir != null && !['./secrets', '/run/secrets'].includes(config.secretDir)) fail('SETUP_CUSTOM_SECRET_PATH_REQUIRES_MANUAL_SETUP');
  config.dataDir = '/data'; config.secretDir = '/run/secrets';
  config.telegram.tokenRef ??= 'telegram-token'; config.actual.passwordRef ??= 'actual-password';
  // Validate untouched settings and unknown keys, while allowing this form to
  // repair placeholders/invalid values in precisely the fields it asks about.
  validateConfig({ ...config, dryRun: true,
    telegram: { ...config.telegram, userId: 123, chatId: 123 },
    actual: { ...config.actual, serverURL: 'http://host.docker.internal:5006', budgetId: 'synthetic-budget' },
    ollama: { ...config.ollama, enabled: false, url: 'http://host.docker.internal:11434', model: null, localOnlyConfirmed: false }
  }, '/app');
  return { config, actualDefaultBase, originalBudgetId: config.actual.budgetId };
}

function persistActualDefault(config, actualDefaultBase) {
  if (actualDefaultBase == null) return;
  const leaf = Object.fromEntries(ACTUAL_LEAF_KEYS.filter(key => Object.hasOwn(config.actual, key)).map(key => [key, config.actual[key]]));
  const { defaultBase, bases } = config.actual;
  config.actual = { defaultBase, bases: { ...bases, [actualDefaultBase]: leaf } };
}

// Every destination is a fixed configuration path or a previously validated
// secret reference. Keep financial state entirely outside this transaction.
export async function commitSetup({ root, stage, configBytes, originalConfig, secrets, owner = 1000, rename = fs.rename }) {
  const privateRoot = path.join(root, '.setup-private'), secretRoot = path.join(root, 'secrets');
  await directory(secretRoot);
  const nowConfig = await regular(path.join(root, 'config.json'));
  if (!!nowConfig !== !!originalConfig || (nowConfig && !nowConfig.bytes.equals(originalConfig.bytes))) fail('SETUP_CHANGED_DURING_PROMPTS');
  for (const [ref, value] of secrets) {
    if (!reference(ref)) fail('SETUP_UNSAFE_REFERENCE');
    const current = await regular(path.join(secretRoot, ref), 16384);
    if (!!current !== !!value.original || (current && !current.bytes.equals(value.original.bytes))) fail('SETUP_CHANGED_DURING_PROMPTS');
  }
  const backups = path.join(privateRoot, 'backups'); await directory(backups, { create: true });
  const backup = path.join(backups, randomUUID()); await fs.mkdir(backup, { mode: 0o700 });
  if (originalConfig) await fs.writeFile(path.join(backup, 'config.json'), originalConfig.bytes, { mode: 0o600, flag: 'wx' });
  const files = [];
  for (const [ref, value] of secrets) {
    if (value.original) await fs.writeFile(path.join(backup, 'secret-' + ref), value.original.bytes, { mode: 0o600, flag: 'wx' });
    files.push({ target: path.join(secretRoot, ref), bytes: value.bytes, original: value.original });
  }
  files.push({ target: path.join(root, 'config.json'), bytes: configBytes, original: originalConfig });
  const secretStat = await entry(secretRoot), createdSecrets = await directory(secretRoot, { create: true });
  const applied = [];
  try {
    await own(secretRoot, owner, 0o700);
    for (const [index, file] of files.entries()) {
      const temporary = path.join(stage, 'commit-' + index);
      await fs.writeFile(temporary, file.bytes, { mode: 0o600, flag: 'wx' }); await own(temporary, owner, 0o600);
      await rename(temporary, file.target); applied.push(file);
    }
  } catch {
    let rollbackFailed = false;
    for (const [index, file] of applied.reverse().entries()) {
      try {
        if (file.original) {
          const restore = path.join(stage, 'restore-' + index);
          await fs.writeFile(restore, file.original.bytes, { mode: 0o600, flag: 'wx' });
          if (process.platform !== 'win32') { await fs.chown(restore, file.original.uid, file.original.gid); await fs.chmod(restore, file.original.mode); }
          await fs.rename(restore, file.target);
        } else await fs.unlink(file.target);
      } catch { rollbackFailed = true; }
    }
    try {
      if (createdSecrets) await fs.rmdir(secretRoot);
      else if (secretStat && process.platform !== 'win32') { await fs.chown(secretRoot, secretStat.uid, secretStat.gid); await fs.chmod(secretRoot, secretStat.mode & 0o777); }
    } catch { rollbackFailed = true; }
    fail(rollbackFailed ? 'SETUP_ROLLBACK_REQUIRED_PRIVATE_BACKUP' : 'SETUP_SAVE_FAILED_ROLLED_BACK');
  }
}

export async function runDockerSetup({ root = '/setup', io, owner = 1000, telegramInfo = telegramSetupInfo, commit = commitSetup } = {}) {
  const privateRoot = path.join(root, '.setup-private'), secretRoot = path.join(root, 'secrets');
  let stage, createdPrivate = false;
  const secrets = new Map();
  try {
    await directory(root); await directory(secretRoot); await directory(privateRoot);
    const originalConfig = await regular(path.join(root, 'config.json'));
    let raw;
    try { raw = JSON.parse((originalConfig?.bytes ?? await fs.readFile(new URL('../../config.docker.example.json', import.meta.url))).toString('utf8').replace(/^\uFEFF/, '')); }
    catch { fail('SETUP_CONFIG_JSON_INVALID'); }
    const { config, actualDefaultBase, originalBudgetId } = prepareConfig(raw);
    io.write('Assistente Docker: Enter mantém o valor existente; segredos ficam ocultos. Nada será substituído antes da confirmação final.');
    config.actual.serverURL = await askValue(io, 'URL do Actual acessível pelo container', safeURL(config.actual.serverURL, 'http://host.docker.internal:5006'));
    config.actual.budgetId = await askValue(io, 'Sync ID do orçamento Actual', /^[A-Za-z0-9_-]{1,128}$/.test(config.actual.budgetId ?? '') && !config.actual.budgetId.startsWith('REPLACE_') ? config.actual.budgetId : '');
    const askSecret = async (ref, label, valid = () => true) => {
      if (!reference(ref)) fail('SETUP_UNSAFE_REFERENCE');
      if (secrets.has(ref)) fail('SETUP_SECRET_REFERENCES_MUST_BE_DISTINCT');
      const original = await regular(path.join(secretRoot, ref), 16384);
      let existing;
      try { existing = secretValue(original); } catch { existing = null; }
      if (existing && !valid(existing)) existing = null;
      if (original && !existing) io.write('O arquivo existente tem formato inválido. Informe um substituto; o original será preservado até a confirmação final.');
      let value;
      for (;;) {
        value = await io.ask(label + (existing ? ' [Enter mantém o arquivo existente]' : '') + ': ', { secret: true });
        if (!value && existing) { secrets.set(ref, { original, bytes: original.bytes }); return; }
        if (value && !/[\r\n\0]/.test(value) && Buffer.byteLength(value) <= 16383 && valid(value)) break;
        io.write('Informe um segredo em uma única linha.');
      }
      secrets.set(ref, { original, bytes: Buffer.from(value + '\n') });
    };
    await askSecret(config.telegram.tokenRef, 'Token Telegram', value => /^\d+:[A-Za-z0-9_-]+$/.test(value));
    await askSecret(config.actual.passwordRef, 'Senha do servidor Actual');
    if (await yes(io, 'O orçamento Actual usa senha de criptografia ponta a ponta?', !!config.actual.encryptionPasswordRef)) {
      config.actual.encryptionPasswordRef ??= 'actual-encryption-password';
      await askSecret(config.actual.encryptionPasswordRef, 'Senha de criptografia do orçamento Actual');
    } else config.actual.encryptionPasswordRef = null;
    createdPrivate = await directory(privateRoot, { create: true });
    if (process.platform !== 'win32' && ((await fs.lstat(privateRoot)).mode & 0o077)) fail('SETUP_PRIVATE_DIRECTORY_PERMISSIONS');
    stage = path.join(privateRoot, 'run-' + randomUUID()); await fs.mkdir(stage, { mode: 0o700 });
    // The existing helper reads a private mounted file; no token travels through
    // argv, environment variables, a JSON document or a shell command.
    await fs.writeFile(path.join(stage, 'telegram-token'), secrets.get(config.telegram.tokenRef).bytes, { mode: 0o600, flag: 'wx' });
    await io.ask('Envie /start ao seu bot no chat privado e pressione Enter para consultar seus IDs: ');
    const info = await telegramInfo({ secretDir: stage, tokenRef: 'telegram-token' });
    if (info.event === 'telegram_info_failed') {
      const codes = new Set(['NETWORK_FAILED','TELEGRAM_REJECTED','TELEGRAM_WEBHOOK_ACTIVE','TELEGRAM_RATE_LIMITED','SECRET_UNAVAILABLE','SECRET_PERMISSIONS']);
      const code = codes.has(info.code) ? info.code : 'NETWORK_FAILED';
      io.write('Consulta Telegram: ' + code + '.');
      if (['TELEGRAM_REJECTED','TELEGRAM_WEBHOOK_ACTIVE','SECRET_UNAVAILABLE','SECRET_PERMISSIONS'].includes(code)) fail('SETUP_TELEGRAM_CREDENTIAL_OR_WEBHOOK');
    }
    let chosen;
    if (info.event === 'telegram_info_ok' && !info.updatesAtLimit && info.candidates.length) {
      for (const [index, pair] of info.candidates.entries()) io.write(`${index + 1}. userId=${pair.userId}; chatId=${pair.chatId}`);
      const index = info.candidates.length === 1 ? 0 : Number(await askValue(io, 'Número do seu chat na lista')) - 1;
      const candidate = info.candidates[index];
      if (candidate && await yes(io, 'Confirma que esses IDs pertencem ao SEU chat privado?', false)) chosen = candidate;
    } else {
      if (info.updatesAtLimit) io.write('Somente as primeiras 100 mensagens foram examinadas, sem avançar o cursor; essa página não prova quem é o responsável.');
      io.write('Não foi possível selecionar seu chat nesta leitura. Confira o bot exclusivo e informe os IDs manualmente.');
    }
    if (!chosen) {
      const userId = Number(await askValue(io, 'Seu userId Telegram (número)', Number.isSafeInteger(config.telegram.userId) && config.telegram.userId > 0 && config.telegram.userId !== 123456789 && originalConfig ? String(config.telegram.userId) : ''));
      const chatId = Number(await askValue(io, 'Seu chatId privado (número)', String(userId)));
      if (!Number.isSafeInteger(userId) || userId <= 0 || chatId !== userId) fail('SETUP_PRIVATE_CHAT_IDS_INVALID');
      if (!await yes(io, 'Confirma que esses IDs pertencem ao SEU chat privado?', false)) throw new SetupCancelled();
      chosen = { userId, chatId };
    }
    config.telegram.userId = chosen.userId; config.telegram.chatId = chosen.chatId;
    const oldOllama = config.ollama ?? {};
    const enabled = await yes(io, 'Ativar interpretação pelo Ollama local?', oldOllama.enabled === true);
    config.ollama = { ...oldOllama, enabled };
    if (enabled) {
      config.ollama.url = await askValue(io, 'URL do Ollama acessível pelo container', safeURL(oldOllama.url, 'http://host.docker.internal:11434'));
      config.ollama.model = await askValue(io, 'Nome exato do modelo local', typeof oldOllama.model === 'string' && /^[A-Za-z0-9._/:-]+$/.test(oldOllama.model) ? oldOllama.model : '');
      config.ollama.localOnlyConfirmed = await yes(io, 'Confirma modelo local e recursos cloud desativados no servidor Ollama?', false);
      if (!config.ollama.localOnlyConfirmed) throw new SetupCancelled();
      config.ollama.allowPrivateAddress = await yes(io, 'Permitir IP literal privado para o Ollama?', oldOllama.allowPrivateAddress === true);
    }
    config.dryRun = !await yes(io, 'Permitir escrita real de categorias no Actual após confirmação?', raw.dryRun === false);
    config.backup ??= { keyRef: null };
    if (!config.dryRun && !config.backup.keyRef) config.backup.keyRef = 'backup-key';
    if (config.backup.keyRef) {
      const ref = config.backup.keyRef;
      if (!reference(ref) || secrets.has(ref)) fail('SETUP_SECRET_REFERENCES_MUST_BE_DISTINCT');
      const original = await regular(path.join(secretRoot, ref), 16384);
      if (!original && raw.backup?.keyRef) fail('SETUP_RESTORE_EXISTING_BACKUP_KEY');
      if (original && !/^[a-fA-F0-9]{64}$/.test(secretValue(original))) fail('SETUP_RESTORE_EXISTING_BACKUP_KEY');
      secrets.set(ref, { original, bytes: original?.bytes ?? Buffer.from(randomBytes(32).toString('hex') + '\n') });
    }
    persistActualDefault(config, actualDefaultBase);
    const validated = validateConfig(config, '/app');
    io.write(`Resumo: Actual em ${new URL(validated.actual.serverURL).origin}; userId=${validated.telegram.userId}; chatId=${validated.telegram.chatId}.`);
    io.write(`Dados em /data; segredos em /run/secrets; Ollama ${validated.ollama.enabled ? 'ativado com confirmação local' : 'desativado'}; escrita Actual ${validated.dryRun ? 'em simulação' : 'habilitada com aprovação por operação'}.`);
    if (originalConfig && ['householdId'].some(k => raw[k] !== config[k]) || originalConfig && (originalBudgetId !== validated.actual.budgetId || raw.telegram.userId !== config.telegram.userId || raw.telegram.chatId !== config.telegram.chatId || !secrets.get(config.telegram.tokenRef).bytes.equals(secrets.get(config.telegram.tokenRef).original?.bytes ?? Buffer.alloc(0)))) {
      io.write('A identidade ou o token mudou. O volume existente conserva seus vínculos de residência/orçamento/responsável/bot; este assistente não redefine o banco.');
    }
    io.write('Ao salvar, configuração e segredos ficarão privados e acessíveis ao UID 1000. Uma cópia privada dos arquivos substituídos será preservada.');
    if (!await yes(io, 'Salvar esta configuração e os segredos?', false)) throw new SetupCancelled();
    io.check?.();
    await commit({ root, stage, configBytes: Buffer.from(JSON.stringify(config, null, 2) + '\n'), originalConfig, secrets, owner });
    io.write('Configuração salva. Backups privados ficam em .setup-private/backups; preserve a chave de backup existente.');
    return { status: 'saved' };
  } catch (error) {
    if (error instanceof SetupCancelled) { io.write('Configuração cancelada; os arquivos de configuração e segredos anteriores foram preservados.'); return { status: 'cancelled' }; }
    const diagnostic = configDiagnostic(error);
    if (diagnostic) io.write(`Configuração inválida: campo ${diagnostic.field}; motivo ${diagnostic.reason}. Nenhum ajuste automático desse campo foi aplicado.`);
    else {
      const allowed = new Set(['SETUP_UNSAFE_FILE','SETUP_UNSAFE_DIRECTORY','SETUP_CONFIG_JSON_INVALID','SETUP_CONFIG_STRUCTURE_INVALID','SETUP_SECRET_FORMAT_INVALID','SETUP_UNSAFE_REFERENCE','SETUP_SECRET_REFERENCES_MUST_BE_DISTINCT','SETUP_PRIVATE_CHAT_IDS_INVALID','SETUP_RESTORE_EXISTING_BACKUP_KEY','SETUP_CHANGED_DURING_PROMPTS','SETUP_SAVE_FAILED_ROLLED_BACK','SETUP_ROLLBACK_REQUIRED_PRIVATE_BACKUP','SETUP_PRIVATE_DIRECTORY_PERMISSIONS','SETUP_CUSTOM_DATA_PATH_REQUIRES_MANUAL_SETUP','SETUP_CUSTOM_SECRET_PATH_REQUIRES_MANUAL_SETUP','SETUP_TELEGRAM_CREDENTIAL_OR_WEBHOOK']);
      io.write('Falha de configuração: ' + (allowed.has(error.message) ? error.message : 'SETUP_FAILED') + '.');
    }
    return { status: 'failed' };
  } finally {
    // Confined cleanup: a generated run directory only, never data or volumes.
    if (stage && path.dirname(stage) === privateRoot && /^run-[a-f0-9-]{36}$/.test(path.basename(stage))) {
      const stat = await entry(stage);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) {
        for (const name of await fs.readdir(stage)) {
          const target = path.join(stage, name), item = await entry(target);
          if (item?.isFile() || item?.isSymbolicLink()) await fs.unlink(target);
        }
        await fs.rmdir(stage);
      }
    }
    if (createdPrivate) { try { await fs.rmdir(privateRoot); } catch {} }
  }
}
