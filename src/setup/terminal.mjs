import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export class SetupCancelled extends Error { constructor() { super('SETUP_CANCELLED'); } }
export function terminalIO({ input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('SETUP_TTY_REQUIRED');
  let hidden = false;
  const controller = new AbortController();
  const filtered = new Writable({ write(chunk, encoding, done) { if (!hidden) output.write(chunk, encoding); done(); } });
  filtered.isTTY = true; filtered.columns = output.columns ?? 80;
  const reader = createInterface({ input, output: filtered, terminal: true, historySize: 0 });
  const cancel = () => { controller.abort(); reader.close(); };
  reader.on('SIGINT', cancel); reader.on('close', () => controller.abort());
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  return {
    write(text) { output.write(text + '\n'); },
    async ask(prompt, { secret = false } = {}) {
      if (controller.signal.aborted) throw new SetupCancelled();
      hidden = secret;
      if (secret) output.write(prompt);
      try { return await reader.question(secret ? '' : prompt, { signal: controller.signal }); }
      catch { throw new SetupCancelled(); }
      finally { hidden = false; if (secret) output.write('\n'); }
    },
    check() { if (controller.signal.aborted) throw new SetupCancelled(); },
    close() {
      reader.close(); input.setRawMode?.(false);
      process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
    }
  };
}
