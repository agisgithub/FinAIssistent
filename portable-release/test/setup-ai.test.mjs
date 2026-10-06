import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAISetup } from '../src/setup/ai.mjs';
import { commitSetup } from '../src/setup/wizard.mjs';
import { SetupCancelled } from '../src/setup/terminal.mjs';
import { preflight } from '../src/preflight.mjs';
import { inputConfig,tempDirectory } from './helpers.mjs';
const owner=process.getuid?.()??1000;
function io(answers){const pending=[...answers],transcript=[];return{pending,transcript,write:t=>transcript.push(t),async ask(p,options={}){transcript.push(p);const v=pending.shift();if(v===undefined)throw new SetupCancelled();if(!options.secret)transcript.push(v);return v;}};}
async function fixture(t){const root=tempDirectory(t),config={...inputConfig(),retentionDays:25,backup:{keyRef:'backup-key'},categorization:{rules:[]},dryRun:false};await fs.mkdir(path.join(root,'secrets'),{mode:0o700});await fs.mkdir(path.join(root,'data'));await fs.writeFile(path.join(root,'config.json'),JSON.stringify(config));await fs.writeFile(path.join(root,'compose.override.yaml'),'OVERRIDE_SENTINEL');await fs.writeFile(path.join(root,'data','state.sqlite'),'STATE_SENTINEL');for(const name of ['actual-password','telegram-token','backup-key'])await fs.writeFile(path.join(root,'secrets',name),'PRESERVE_'+name,{mode:0o600});return {root,config};}
const available=[];
const factory=c=>({async listModels({provider}){assert.equal(provider,'ollama');assert.equal(c.ollama.contextTokens,4096);available.push(c);return[{id:'synthetic-tools:latest',contextTokens:32768,tools:true}];}});
const answers=['','s','','','s','','','s','GEMINI_AUTH_CANARY','','s'];
test('AI-only setup preserves Actual/Telegram/backups/data/network override and masks the new key',async t=>{
  const {root,config}=await fixture(t),terminal=io(answers);
  const result=await runAISetup({root,io:terminal,owner,providersFactory:factory});assert.equal(result.status,'saved');assert.equal(terminal.pending.length,0);
  const saved=JSON.parse(await fs.readFile(path.join(root,'config.json'),'utf8'));
  for(const key of Object.keys(config))if(!['privacy','ollama','assistant','gemini'].includes(key))assert.deepEqual(saved[key],config[key]);
  assert.equal(saved.ollama.contextTokens,32768);assert.equal(saved.assistant.defaultProvider,'ollama');assert.equal(saved.gemini.apiKeyRef,'gemini-api-key');assert.equal(saved.privacy.externalProviders,true);
  assert.equal(await fs.readFile(path.join(root,'secrets','gemini-api-key'),'utf8'),'GEMINI_AUTH_CANARY\n');
  assert.doesNotMatch(JSON.stringify(terminal.transcript),/GEMINI_AUTH_CANARY/);assert.doesNotMatch(JSON.stringify(saved),/GEMINI_AUTH_CANARY/);
  assert.equal(await fs.readFile(path.join(root,'compose.override.yaml'),'utf8'),'OVERRIDE_SENTINEL');assert.equal(await fs.readFile(path.join(root,'data','state.sqlite'),'utf8'),'STATE_SENTINEL');
  for(const name of ['actual-password','telegram-token','backup-key'])assert.equal(await fs.readFile(path.join(root,'secrets',name),'utf8'),'PRESERVE_'+name);
});
test('AI-only cancellation at every prompt preserves original config and secrets',async t=>{
  for(let i=0;i<answers.length;i++){const{root}=await fixture(t),before=await fs.readFile(path.join(root,'config.json'));const terminal=io(answers.slice(0,i));assert.equal((await runAISetup({root,io:terminal,owner,providersFactory:factory})).status,'cancelled');assert.deepEqual(await fs.readFile(path.join(root,'config.json')),before);assert.equal(await fs.stat(path.join(root,'secrets','gemini-api-key')).then(()=>true,()=>false),false);assert.doesNotMatch(JSON.stringify(terminal.transcript),/GEMINI_AUTH_CANARY/);}
});
test('AI-only config and secret commit rolls back on failure without touching unrelated state',async t=>{
  const{root}=await fixture(t),before=await fs.readFile(path.join(root,'config.json'));let calls=0;
  const result=await runAISetup({root,io:io(answers),owner,providersFactory:factory,commit:args=>commitSetup({...args,rename:async(...p)=>{if(++calls===2)throw Error('FAIL_CANARY');return fs.rename(...p);}})});
  assert.equal(result.status,'failed');assert.deepEqual(await fs.readFile(path.join(root,'config.json')),before);assert.equal(await fs.stat(path.join(root,'secrets','gemini-api-key')).then(()=>true,()=>false),false);assert.equal(await fs.readFile(path.join(root,'data','state.sqlite'),'utf8'),'STATE_SENTINEL');
});
test('AI-only reconfiguration keeps an existing Gemini key on Enter and refuses capacity beyond model',async t=>{
  const{root}=await fixture(t);assert.equal((await runAISetup({root,io:io(answers),owner,providersFactory:factory})).status,'saved');
  const terminal=io(['','','','','s','','','','','','s']);assert.equal((await runAISetup({root,io:terminal,owner,providersFactory:factory})).status,'saved');assert.equal(await fs.readFile(path.join(root,'secrets','gemini-api-key'),'utf8'),'GEMINI_AUTH_CANARY\n');
  const before=await fs.readFile(path.join(root,'config.json'));assert.equal((await runAISetup({root,io:io(['','','','','s','','99999']),owner,providersFactory:factory})).status,'failed');assert.deepEqual(await fs.readFile(path.join(root,'config.json')),before);
});
test('AI-only offline inventory is explicitly pending and never calls Actual/Telegram',async t=>{
  const{root}=await fixture(t),terminal=io(['','s','','','s','my-local-model','16384','n','s']);
  const result=await runAISetup({root,io:terminal,owner,providersFactory:()=>({listModels:async()=>{throw Error('SECRET_CANARY');}})});assert.equal(result.status,'saved');assert.match(terminal.transcript.join('\n'),/verificação pendente/);assert.doesNotMatch(terminal.transcript.join('\n'),/SECRET_CANARY/);
});
test('Gemini setup validates only metadata using the in-memory key and rejects a model absent from catalog',async t=>{
  for(const listed of [true,false]) {
    const{root}=await fixture(t);const before=await fs.readFile(path.join(root,'config.json'));let queries=0;
    const terminal=io(['','n','s','AUTH_METADATA_CANARY','','s']);
    const result=await runAISetup({root,io:terminal,owner,providersFactory:(c,options)=>({async listModels({provider}) {queries++;assert.equal(provider,'gemini');assert.equal(await options.resolveSecret(c.gemini.apiKeyRef),'AUTH_METADATA_CANARY');return listed?[{id:'gemini-3.8-flash'}]:[{id:'other-model'}];}})});
    assert.equal(queries,1);assert.equal(result.status,listed?'saved':'failed');assert.doesNotMatch(terminal.transcript.join('\n'),/AUTH_METADATA_CANARY/);if(!listed)assert.deepEqual(await fs.readFile(path.join(root,'config.json')),before);
  }
});
test('Linux AI-only Bash wrapper parses and runtime image includes its entrypoint', {skip:process.platform==='win32'?'Bash syntax is checked by Linux CI; native Windows cannot provide the required Bash runtime.':false},async()=>{
  const result=spawnSync('bash',['-n','scripts/configure-ai.sh'],{encoding:'utf8'});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
  const dockerfile=await fs.readFile('Dockerfile','utf8');assert.match(dockerfile,/COPY scripts\/configure-ai\.mjs \.\/scripts\//);
});
test('offline preflight checks Gemini reference only when enabled and reports no secret value',async t=>{
  const root=tempDirectory(t),filename=path.join(root,'config.json');
  await fs.mkdir(path.join(root,'data','actual'),{recursive:true});await fs.mkdir(path.join(root,'secrets'),{mode:0o700});
  await fs.writeFile(path.join(root,'secrets','telegram-token'),'123:CANARY_TOKEN',{mode:0o600});await fs.writeFile(path.join(root,'secrets','actual-password'),'CANARY_ACTUAL',{mode:0o600});
  const config={...inputConfig(),privacy:{externalProviders:true},gemini:{enabled:true,apiKeyRef:'gemini-api-key'}};await fs.writeFile(filename,JSON.stringify(config));
  let result=await preflight(filename);assert.equal(result.ok,false);assert.equal(result.checks.find(c=>c.field==='gemini.apiKeyRef').reason,'secret_unavailable');
  await fs.writeFile(path.join(root,'secrets','gemini-api-key'),'INVALID CANARY_KEY',{mode:0o600});result=await preflight(filename);assert.equal(result.checks.find(c=>c.field==='gemini.apiKeyRef').reason,'secret_format_invalid');
  await fs.writeFile(path.join(root,'secrets','gemini-api-key'),'AUTH_CANARY_KEY',{mode:0o600});result=await preflight(filename);assert.equal(result.ok,true);assert.doesNotMatch(JSON.stringify(result),/CANARY/);
  config.gemini.enabled=false;config.privacy.externalProviders=false;await fs.unlink(path.join(root,'secrets','gemini-api-key'));await fs.writeFile(filename,JSON.stringify(config));result=await preflight(filename);assert.equal(result.ok,true);assert.equal(result.checks.some(c=>c.field==='gemini.apiKeyRef'),false);
});
