import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mappedActual,relocateConfig,requireEmpty} from '../portable/helper.mjs';
import {validateOllamaConfig} from '../src/llm/config.mjs';
const fixture=()=>JSON.parse(readFileSyncExample);
const readFileSyncExample=await readFile(new URL('../config.docker.example.json',import.meta.url),'utf8');
test('portable: maps only known source servers, never an arbitrary external budget',()=>{
  assert.equal(mappedActual('http://localhost:5006'),'http://actual:5006');
  assert.equal(mappedActual('http://10.11.46.109:5007'),'http://actual-aig:5006');
  assert.throws(()=>mappedActual('https://someone-else.example:5006'));
  assert.throws(()=>mappedActual('http://localhost:9999'));
});
test('portable: nonempty destinations are refused',()=>{
  assert.doesNotThrow(()=>requireEmpty([[],[]]));
  assert.throws(()=>requireEmpty([[],['accounts.sqlite']]));
});
test('portable: compose Ollama DNS requires explicit fixed-host opt-in',()=>{
  const previous=process.env.FINAI_LOCAL_OLLAMA_HOST;
  try{
    delete process.env.FINAI_LOCAL_OLLAMA_HOST;
    assert.throws(()=>validateOllamaConfig({url:'http://ollama:11434'}));
    process.env.FINAI_LOCAL_OLLAMA_HOST='ollama';
    assert.equal(validateOllamaConfig({url:'http://ollama:11434'}).url,'http://ollama:11434');
    assert.throws(()=>validateOllamaConfig({url:'http://external.example:11434'}));
  }finally{if(previous===undefined)delete process.env.FINAI_LOCAL_OLLAMA_HOST;else process.env.FINAI_LOCAL_OLLAMA_HOST=previous;}
});
test('portable: budget identity and privacy are retained during relocation',()=>{
  const previous=process.env.FINAI_LOCAL_OLLAMA_HOST;process.env.FINAI_LOCAL_OLLAMA_HOST='ollama';
  try{
    const config=fixture();config.actual.bases.principal.budgetId='synthetic-budget';
    config.actual.bases.principal.serverURL='http://localhost:5006';
    const next=relocateConfig(config);
    assert.equal(next.actual.bases.principal.budgetId,'synthetic-budget');
    assert.equal(next.telegram.userId,config.telegram.userId);
    assert.deepEqual(next.privacy,config.privacy);
    assert.equal(next.dryRun,config.dryRun);
    assert.equal(next.secretDir,'/settings/secrets');
    assert.equal(relocateConfig(config,{tenant:true}).secretDir,'/tmp/finaissistent-onboarding/u123456789');
  }finally{if(previous===undefined)delete process.env.FINAI_LOCAL_OLLAMA_HOST;else process.env.FINAI_LOCAL_OLLAMA_HOST=previous;}
});
test('portable: Telegram requires deliberate activation',async()=>{
  const compose=await readFile(new URL('../compose.portable.yaml',import.meta.url),'utf8');
  assert.match(compose,/profiles: \[telegram\]/);
  const cli=await readFile(new URL('../portable/finai.mjs',import.meta.url),'utf8');
  assert.match(cli,/SOURCE_BOT_STOPPED/);
});

test('portable: secret files are ignored without excluding the resolver source',async()=>{
  const ignore=await readFile(new URL('../.gitignore',import.meta.url),'utf8');
  assert.match(ignore,/^\/secrets\/$/m);
  assert.match(ignore,/^!\/src\/secrets\/$/m);
  assert.doesNotMatch(ignore,/^secrets\/$/m);
  const source=await readFile(new URL('../src/secrets/resolver.mjs',import.meta.url),'utf8');
  assert.match(source,/export/);
});
