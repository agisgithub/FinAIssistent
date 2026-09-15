import { terminalIO } from '../src/setup/terminal.mjs';
import { runAISetup } from '../src/setup/ai.mjs';
process.umask(0o077);
let io;
try {
  if(process.argv.length!==2) throw new Error('SETUP_USAGE');
  io=terminalIO();
  const result=await runAISetup({root:process.env.AI_SETUP_ROOT??process.cwd(),io,owner:process.getuid?.()===0?1000:process.getuid?.()??1000});
  process.exitCode=result.status==='saved'?0:result.status==='cancelled'?3:1;
} catch {
  process.stdout.write('SETUP_FAILED: use npm run setup:ai ou bash scripts/configure-ai.sh em um terminal interativo.\n');process.exitCode=1;
} finally {io?.close();}
