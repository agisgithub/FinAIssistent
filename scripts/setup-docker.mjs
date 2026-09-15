import { terminalIO } from '../src/setup/terminal.mjs';
import { runDockerSetup } from '../src/setup/wizard.mjs';

process.umask(0o077);
let io;
try {
  if (process.argv.length !== 2) throw new Error('SETUP_USAGE');
  io = terminalIO();
  const result = await runDockerSetup({ io });
  process.exitCode = result.status === 'saved' ? 0 : result.status === 'cancelled' ? 3 : 1;
} catch {
  process.stdout.write('SETUP_FAILED: execute bash scripts/setup-docker.sh em um terminal interativo.\n');
  process.exitCode = 1;
} finally { io?.close(); }
