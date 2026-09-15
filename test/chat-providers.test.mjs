import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatProviders, GEMINI_PRIVACY_NOTICE } from '../src/llm/chat.mjs';
import { validateConfig } from '../src/config.mjs';
import { OllamaIntentClient } from '../src/llm/ollama.mjs';
import { inputConfig } from './helpers.mjs';
import { FINANCE_TOOL_DEFINITIONS } from '../src/application/assistant-tools.mjs';
import { CONVERSATION_SYSTEM } from '../src/conversation/service.mjs';

const tool={name:'query_finances',description:'Consulta limitada',parameters:{type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false}};
const messages=[{role:'system',content:'Use somente as ferramentas declaradas.'},{role:'user',content:'Mostre gastos.'}];
const local={enabled:true,model:'local-test',localOnlyConfirmed:true,contextTokens:32768};
const remote={enabled:true,model:'gemini-3.8-flash',apiKeyRef:'gemini-key'};
const config=(change={})=>validateConfig({...inputConfig(),ollama:local,...change});
const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
const entry={name:'local-test:latest',model:'local-test:latest',size:100,digest:'a'.repeat(64),details:{format:'gguf'}};
const show={details:{format:'gguf'},capabilities:['completion','tools'],model_info:{'general.architecture':'test','test.context_length':32768}};
const modelInfo={name:'models/gemini-3.8-flash',supportedGenerationMethods:['generateContent'],inputTokenLimit:1048576,outputTokenLimit:65536};
function localFetch(last, overrides={}) {const calls=[];return {calls,async fetch(url,init){calls.push({url,init,body:init.body?JSON.parse(init.body):null});return response(url.endsWith('/api/tags')?(overrides.tags??{models:[entry]}):url.endsWith('/api/show')?(overrides.show??show):last);}};}
function geminiFetch(last) {const calls=[];return {calls,async fetch(url,init){calls.push({url,init,body:init.body?JSON.parse(init.body):null});return response(url.endsWith(':generateContent')?last:modelInfo);}};}
const geminiConfig=()=>config({privacy:{externalProviders:true},gemini:remote});

test('old configs stay local; cloud needs explicit server config, reference and chat enablement',async()=>{
  const c=validateConfig(inputConfig());assert.equal(c.assistant.defaultProvider,'ollama');assert.equal(c.assistant.historyTtlMinutes,1440);assert.equal(c.gemini.enabled,false);
  assert.throws(()=>validateConfig({...inputConfig(),privacy:{externalProviders:true}}),/CONFIG_INVALID/);
  assert.doesNotThrow(()=>new OllamaIntentClient(geminiConfig()));
  for(const ref of ['telegram-token','actual-password','budget-password','backup-key']) assert.throws(()=>validateConfig({...inputConfig(),actual:{...inputConfig().actual,encryptionPasswordRef:'budget-password'},backup:{keyRef:'backup-key'},privacy:{externalProviders:true},gemini:{...remote,apiKeyRef:ref}}),/CONFIG_INVALID/);
  for(const change of [{gemini:{...remote,apiKey:'CANARY'}},{gemini:{...remote,apiKeyRef:'../key'}},{assistant:{historyTtlMinutes:1441}},{assistant:{defaultProvider:'gemini'}},{assistant:JSON.parse('{"__proto__":true}')}]) assert.throws(()=>config(change),/CONFIG_INVALID/);
  await assert.rejects(new ChatProviders(c).complete({provider:'gemini',messages}),/GEMINI_DISABLED/);
  await assert.rejects(new ChatProviders({...c,assistant:{enabled:false}}).listModels({provider:'ollama'}),/CHAT_DISABLED/);
  assert.match(GEMINI_PRIVACY_NOTICE,/nomes, notas, datas e valores/);
});
test('Ollama verifies local inventory and tools capability before transmitting any question',async()=>{
  for(const overrides of [{tags:{models:[{...entry,remote_host:'https://ollama.com',remote_model:'proxy'}]}},{show:{...show,capabilities:['completion']}},{show:{...show,model_info:{'general.architecture':'test','test.context_length':2048}}},{tags:{models:[{...entry,digest:'invalid'}]}}]) {
    const fake=localFetch({},overrides),client=new ChatProviders(config(),{fetchImpl:fake.fetch});
    await assert.rejects(client.complete({provider:'ollama',messages,tools:[tool]}),/OLLAMA_MODEL_UNSAFE/);
    assert.equal(fake.calls.some(c=>c.url.endsWith('/api/chat')),false);assert.equal(JSON.stringify(fake.calls).includes('Mostre gastos'),false);
  }
});
test('Ollama tool round uses native message including thinking and correlates bounded tool result',async()=>{
  const raw={role:'assistant',content:'',thinking:'PRIVATE_THINKING',tool_calls:[{function:{index:0,name:tool.name,arguments:{command:'/resumo'}}}]};
  const fake=localFetch({model:'local-test:latest',done:true,done_reason:'stop',message:raw,prompt_eval_count:10,eval_count:3});
  const client=new ChatProviders(config(),{fetchImpl:fake.fetch}),first=await client.complete({provider:'ollama',messages,tools:[tool]});
  assert.equal(first.text,'');assert.equal(first.usage.totalTokens,13);assert.equal(first.assistantMessage.providerContent.content.thinking,'PRIVATE_THINKING');
  await client.complete({provider:'ollama',messages:[...messages,first.assistantMessage,{role:'tool',name:tool.name,toolCallId:first.toolCalls[0].id,content:'{"ok":true}'}],tools:[tool]});
  const body=fake.calls.at(-1).body;assert.equal(body.stream,false);assert.deepEqual(body.messages[2],raw);assert.deepEqual(body.messages[3],{role:'tool',tool_name:tool.name,content:'{"ok":true}'});
});
test('Ollama native tool IDs are accepted and correlated in parallel tool responses',async()=>{
  const raw={role:'assistant',content:'',tool_calls:[
    {id:'call_search_1',function:{index:0,name:tool.name,arguments:{command:'/resumo'}}},
    {id:'call_search_2',function:{index:1,name:tool.name,arguments:{command:'/contas'}}}
  ]};
  const fake=localFetch({model:'local-test:latest',done:true,done_reason:'stop',message:raw,eval_count:22});
  const client=new ChatProviders(config(),{fetchImpl:fake.fetch});
  const first=await client.complete({provider:'ollama',messages,tools:[tool]});
  assert.deepEqual(first.toolCalls.map(c=>c.id),['call_search_1','call_search_2']);
  const history=[...messages,first.assistantMessage,...first.toolCalls.map(c=>({role:'tool',name:c.name,toolCallId:c.id,content:'{"ok":true}'}))];
  await client.complete({provider:'ollama',messages:history,tools:[tool]});
  const sent=fake.calls.at(-1).body.messages;
  assert.deepEqual(sent[2],raw);
  assert.deepEqual(sent.slice(3).map(m=>m.tool_call_id),['call_search_1','call_search_2']);
  assert.equal(sent[3].tool_name,tool.name);
  const altered=structuredClone(history);altered[2].providerContent.content.tool_calls[0].id='different_id';
  const before=fake.calls.length;
  await assert.rejects(client.complete({provider:'ollama',messages:altered,tools:[tool]}),/INPUT_INVALID/);
  assert.equal(fake.calls.length,before);
});

test('Ollama native tool IDs do not bypass ID, argument or tool validation',async()=>{
  const call={id:'call_one',function:{index:0,name:tool.name,arguments:{command:'/resumo'}}};
  for(const calls of [
    [{...call,id:12}], [{...call,id:''}], [{...call,id:'bad id'}], [call,call],
    [{...call,function:{...call.function,name:'arbitrary_write'}}],
    [{...call,function:{...call.function,arguments:'{}'}}], [{...call,unexpected:true}]
  ]) {
    const fake=localFetch({model:'local-test:latest',done:true,done_reason:'stop',message:{role:'assistant',content:'',tool_calls:calls}});
    await assert.rejects(new ChatProviders(config(),{fetchImpl:fake.fetch}).complete({provider:'ollama',messages,tools:[tool]}),/CHAT_INVALID_RESPONSE/);
  }
});

test('Gemini multi-call history preserves native parts, empty signature part and functionResponse IDs',async()=>{
  const raw={role:'model',parts:[{text:'PRIVATE_THOUGHT',thought:true},{text:'',thoughtSignature:'EMPTY_SIGNATURE'},{functionCall:{id:'c1',name:tool.name,args:{command:'/resumo'}},thoughtSignature:'SIGNED_PART'},{functionCall:{id:'c2',name:tool.name,args:{command:'/contas'}}},{text:'Vou consultar.'}]};
  const fake=geminiFetch({candidates:[{content:raw,finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,totalTokenCount:17,thoughtsTokenCount:2}});
  const client=new ChatProviders(geminiConfig(),{fetchImpl:fake.fetch,resolveSecret:async()=> 'AUTH_CANARY_KEY'});
  const first=await client.complete({provider:'gemini',messages,tools:[tool]});
  assert.equal(first.text,'Vou consultar.');assert.equal(first.usage.thoughtTokens,2);assert.deepEqual(first.assistantMessage.providerContent.content,raw);
  await client.complete({provider:'gemini',messages:[...messages,first.assistantMessage,...first.toolCalls.map(c=>({role:'tool',name:c.name,toolCallId:c.id,content:'{"ok":true}'}))],tools:[tool]});
  const request=fake.calls.at(-1);assert.deepEqual(request.body.contents[1],raw);assert.deepEqual(request.body.contents[2].parts.map(p=>p.functionResponse.id),['c1','c2']);
  assert.deepEqual(request.body.tools[0].functionDeclarations[0].parametersJsonSchema,tool.parameters);
  assert.equal(request.init.headers['x-goog-api-key'],'AUTH_CANARY_KEY');assert.equal(request.url.includes('CANARY'),false);assert.equal(request.init.redirect,'error');
});
test('Gemini absent function id uses internal correlation without inventing a native id',async()=>{
  const fake=geminiFetch({candidates:[{finishReason:'STOP',content:{role:'model',parts:[{functionCall:{name:tool.name,args:{command:'/resumo'}},thoughtSignature:'sig'}]}}]});
  const client=new ChatProviders(geminiConfig(),{fetchImpl:fake.fetch,resolveSecret:async()=> 'key'}),first=await client.complete({provider:'gemini',messages,tools:[tool]});
  await client.complete({provider:'gemini',messages:[...messages,first.assistantMessage,{role:'tool',toolCallId:first.toolCalls[0].id,name:tool.name,content:'{"ok":true}'}],tools:[tool]});
  assert.equal(Object.hasOwn(fake.calls.at(-1).body.contents[2].parts[0].functionResponse,'id'),false);
  assert.deepEqual(first.usage,{inputTokens:null,outputTokens:null,totalTokens:null,cachedTokens:null,thoughtTokens:null});
});
test('provider switch drops native thoughts/signatures and never fabricates native tool frames',async()=>{
  const fake=localFetch({model:'local-test',done:true,message:{role:'assistant',content:'OK'}}),client=new ChatProviders(config(),{fetchImpl:fake.fetch});
  const history=[...messages,{role:'assistant',content:'Texto visível',providerContent:{provider:'gemini',model:remote.model,content:{role:'model',parts:[{text:'THOUGHT_SECRET',thought:true},{text:'',thoughtSignature:'SIG_SECRET'}]}}},{role:'user',content:'Continue'}];
  await client.complete({provider:'ollama',messages:history});assert.doesNotMatch(fake.calls.at(-1).init.body,/THOUGHT_SECRET|SIG_SECRET/);
  history[2].toolCalls=[{id:'one',name:tool.name,args:{command:'/resumo'}}];await assert.rejects(client.complete({provider:'ollama',messages:history,tools:[tool]}),/INPUT_INVALID/);
});
test('unknown tools, malformed arguments, duplicate IDs and incomplete/truncated generations are rejected',async()=>{
  const raws=[{role:'model',parts:[{functionCall:{name:'arbitrary_sdk_write',args:{}}}]},{role:'model',parts:[{functionCall:{name:tool.name,args:'{}'}}]},{role:'model',parts:[{functionCall:{id:'same',name:tool.name,args:{}}},{functionCall:{id:'same',name:tool.name,args:{}}}]},{role:'model',parts:[{fileData:{fileUri:'https://attacker'}}]}];
  for(const raw of raws) {const fake=geminiFetch({candidates:[{content:raw,finishReason:'STOP'}]});await assert.rejects(new ChatProviders(geminiConfig(),{fetchImpl:fake.fetch,resolveSecret:async()=> 'key'}).complete({provider:'gemini',messages,tools:[tool]}),/CHAT_INVALID_RESPONSE/);}
  const fake=geminiFetch({candidates:[{content:{role:'model',parts:[{text:'partial'}]},finishReason:'MAX_TOKENS'}]});await assert.rejects(new ChatProviders(geminiConfig(),{fetchImpl:fake.fetch,resolveSecret:async()=> 'key'}).complete({provider:'gemini',messages}),/CHAT_INVALID_RESPONSE/);
});
test('full context/schema byte budget fails before network and never truncates a current filter',async()=>{
  let calls=0;const client=new ChatProviders(config({ollama:{...local,contextTokens:4096}}),{fetchImpl:async()=>{calls++;throw Error('network');}});
  await assert.rejects(client.complete({provider:'ollama',messages:[{role:'system',content:'s'.repeat(2000)},{role:'user',content:'Filtro importante '+ 'u'.repeat(2000)}],tools:[tool]}),/CHAT_CONTEXT_LIMIT/);assert.equal(calls,0);
});
test('bounded body and deadline include a stalled response reader; errors never reflect key/body',async()=>{
  const c=geminiConfig();const oversize=new ChatProviders({...c,gemini:{...c.gemini,maxResponseBytes:1024}},{resolveSecret:async()=> 'SECRET_CANARY',fetchImpl:async()=>new Response('x'.repeat(1025))});
  await assert.rejects(oversize.complete({provider:'gemini',messages}),e=>e.code==='CHAT_INVALID_RESPONSE'&&!JSON.stringify(e).includes('CANARY'));
  const stalled=new ChatProviders({...c,gemini:{...c.gemini,timeoutMs:1000}},{resolveSecret:async()=> 'SECRET_CANARY',fetchImpl:async()=>new Response(new ReadableStream({start(){}}))});
  await assert.rejects(stalled.complete({provider:'gemini',messages}),/GEMINI_TIMEOUT/);
  const error=new ChatProviders(c,{resolveSecret:async()=> 'SECRET_CANARY',fetchImpl:async()=>{throw Error('SECRET_CANARY');}});await assert.rejects(error.complete({provider:'gemini',messages}),e=>e.code==='GEMINI_UNAVAILABLE'&&!JSON.stringify(e).includes('CANARY'));
});
test('no automatic retry or remote fallback on rate limits, blocked input or unavailable provider',async()=>{
  for(const [status,code] of [[429,'GEMINI_RATE_LIMITED'],[403,'GEMINI_REJECTED'],[503,'GEMINI_UNAVAILABLE']]) {let n=0;const client=new ChatProviders(geminiConfig(),{resolveSecret:async()=> 'key',fetchImpl:async()=>{n++;return new Response('CANARY',{status});}});await assert.rejects(client.complete({provider:'gemini',messages}),e=>e.code===code);assert.equal(n,1);}
});
test('model lists filter generateContent and local/cloud models; pagination stays on fixed host',async()=>{
  const calls=[];const client=new ChatProviders(geminiConfig(),{resolveSecret:async()=> 'key',fetchImpl:async(url)=>{calls.push(url);return response(calls.length===1?{models:[modelInfo,{name:'models/embedding',supportedGenerationMethods:['embedContent']}],nextPageToken:'token / query'}:{models:[{...modelInfo,name:'models/other-stable'}]});}});
  assert.deepEqual((await client.listModels({provider:'gemini'})).map(m=>m.id),['gemini-3.8-flash','other-stable']);assert.equal(calls.length,2);assert.match(calls[1],/pageToken=token%20%2F%20query/);
  const fake=localFetch({}, {tags:{models:[entry,{...entry,name:'cloud-test:cloud',model:'cloud-test:cloud',remote_host:'https://cloud'}]}});
  assert.deepEqual((await new ChatProviders(config(),{fetchImpl:fake.fetch}).listModels({provider:'ollama'})).map(m=>m.id),['local-test:latest']);
});
test('real system and finance schemas plus eight detailed installments and a catalog fit the configured 32768 context',async()=>{
  const calls=[],question=[{role:'system',content:CONVERSATION_SYSTEM},{role:'user',content:'Comprei Brastemp em 8 parcelas. Confira as 8 e proponha uma categoria existente.'}];let generations=0;
  const client=new ChatProviders(config(),{fetchImpl:async(url,init)=>{calls.push({url,body:init.body?JSON.parse(init.body):null});if(url.endsWith('/api/tags'))return response({models:[entry]});if(url.endsWith('/api/show'))return response(show);generations++;return response({model:local.model,done:true,message:generations===1?{role:'assistant',content:'',tool_calls:[{function:{name:'search_transactions',arguments:{text:'Brastemp*',start:'2026-01-01',end:'2026-12-31',pageSize:10}}},{function:{name:'list_categories',arguments:{pageSize:10}}}]}:{role:'assistant',content:'Oito parcelas localizadas. Revise a proposta.'}});}});
  const first=await client.complete({provider:'ollama',messages:question,tools:FINANCE_TOOL_DEFINITIONS});
  const rows=Array.from({length:8},(_,i)=>({id:'installment-'+i,date:'2026-09-15',amountCents:-3000,payee:'P'.repeat(200),notes:'N'.repeat(200),category:null,account:{id:'checking',name:'C'.repeat(100)},eligibleForCategoryChange:true}));
  const catalog=Array.from({length:10},(_,i)=>({id:'category-'+i,name:'Categoria '+i+' '+ 'X'.repeat(100),groupId:'group',groupName:'Grupo'}));
  const history=[...question,first.assistantMessage,{role:'tool',toolCallId:first.toolCalls[0].id,name:'search_transactions',content:JSON.stringify({transactions:rows,total:8,truncated:false,complete:true})},{role:'tool',toolCallId:first.toolCalls[1].id,name:'list_categories',content:JSON.stringify({categories:catalog,groups:[{id:'group',name:'Grupo'}],truncated:false})}];
  const final=await client.complete({provider:'ollama',messages:history,tools:FINANCE_TOOL_DEFINITIONS});assert.match(final.text,/Oito/);assert.equal(generations,2);assert.equal(calls.at(-1).body.messages.at(-2).content.includes('"total":8'),true);
  const smaller=new ChatProviders(config({ollama:{...local,contextTokens:8192}}),{fetchImpl:async()=>{throw Error('must not call');}});await assert.rejects(smaller.complete({provider:'ollama',messages:history,tools:FINANCE_TOOL_DEFINITIONS}),/CHAT_CONTEXT_LIMIT/);
});
test('known Gemini default uses low thinking; other available model families do not receive that option',async()=>{
  for(const model of ['gemini-3.8-flash','gemini-2.5-flash']) {
    let sent;const client=new ChatProviders(geminiConfig(),{resolveSecret:async()=> 'key',fetchImpl:async(url,init)=>{if(!url.endsWith(':generateContent'))return response({...modelInfo,name:'models/'+model});sent=JSON.parse(init.body);return response({candidates:[{finishReason:'STOP',content:{role:'model',parts:[{text:'OK'}]}}]});}});
    await client.complete({provider:'gemini',model,messages});assert.equal(sent.generationConfig.maxOutputTokens,4096);assert.deepEqual(sent.generationConfig.thinkingConfig,model==='gemini-3.8-flash'?{thinkingLevel:'low'}:undefined);
  }
});
test('parameterless native call omits args safely and round-trip keeps its signed content intact',async()=>{
  const definition={name:'list_categories',description:'Catálogo',parameters:{type:'object',properties:{}}};
  const raw={role:'model',parts:[{functionCall:{name:'list_categories'},thoughtSignature:'signed'}]};
  const fake=geminiFetch({candidates:[{finishReason:'STOP',content:raw}]}),client=new ChatProviders(geminiConfig(),{resolveSecret:async()=> 'key',fetchImpl:fake.fetch});
  const first=await client.complete({provider:'gemini',messages,tools:[definition]});assert.deepEqual(first.toolCalls[0].args,{});
  await client.complete({provider:'gemini',messages:[...messages,first.assistantMessage,{role:'tool',name:'list_categories',toolCallId:first.toolCalls[0].id,content:'{"categories":[]}'}],tools:[definition]});assert.deepEqual(fake.calls.at(-1).body.contents[1],raw);
});
