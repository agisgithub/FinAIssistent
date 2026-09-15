import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { readJsonLimited } from '../http.mjs';
import { secretResolver } from '../secrets/resolver.mjs';
import { validateOllamaConfig } from './config.mjs';
import { validateAssistantConfig, validateGeminiConfig, validGeminiModel } from './chat-config.mjs';
import { canonicalModel, isRemoteModel, safeLocalEntry, localModelInfo, localInventory, requireLocalModel } from './local-models.mjs';

export const GEMINI_PRIVACY_NOTICE = [
  'GEMINI — ENVIO AO GOOGLE',
  '• Conteúdo: pergunta, memória limitada e resultados financeiros de ferramentas (nomes, notas, datas e valores). O orçamento completo não é enviado. Resumos continuam sendo dados financeiros.',
  '• Sem Cloud Billing ativo no projeto: entradas/saídas podem melhorar produtos e ter revisão humana; os termos orientam não enviar dados pessoais ou sensíveis.',
  '• Com faturamento ativo: entradas/saídas não melhoram produtos, mas há processamento e registros limitados de segurança/abuso. O bot não comprova seu faturamento.',
  '• A chave fica no servidor, usada só para autenticar; senhas/chaves da configuração não entram no contexto. Não cole credenciais no chat: a detecção é limitada.',
  'Confira termos e elegibilidade: https://ai.google.dev/gemini-api/terms',
  'Confirmar autoriza o contexto indicado. Alterações financeiras exigem outra confirmação.'
].join('\n\n');
const API = 'https://generativelanguage.googleapis.com/v1beta';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nameOK = v => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(v);
const idOK = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(v);
const count = v => Number.isSafeInteger(v) && v >= 0 ? v : null;
const fail = (code = 'CHAT_INVALID_RESPONSE') => { throw new AppError(code); };
function jsonValue(value, depth = 0) {
  if (depth > 24) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 2000 && value.every(v => jsonValue(v,depth+1));
  return object(value) && [Object.prototype,null].includes(Object.getPrototypeOf(value)) && Object.entries(value).every(([k,v]) => !['__proto__','prototype','constructor'].includes(k) && jsonValue(v,depth+1));
}
function checkedCalls(calls, tools, max, { native = false } = {}) {
  if (!Array.isArray(calls) || calls.length > max) fail();
  const names = new Set(tools.map(t => t.name)), ids = new Set();
  return calls.map((call, index) => {
    const name = call?.name, args = native && call?.args === undefined ? {} : call?.args;
    if (!nameOK(name) || !names.has(name) || !object(args) || !jsonValue(args)) fail();
    const id = call.id ?? (native ? 'call_' + randomUUID() : undefined);
    if (!idOK(id) || ids.has(id)) fail(); ids.add(id);
    return { id, name, args: structuredClone(args) };
  });
}
function validateInput(messages, tools, config) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 512 || !Array.isArray(tools) || tools.length > 16) fail('INPUT_INVALID');
  if (!jsonValue(messages) || !jsonValue(tools)) fail('INPUT_INVALID');
  const names = new Set();
  for (const t of tools) {
    if (!object(t) || Object.keys(t).some(k => !['name','description','parameters'].includes(k)) || !nameOK(t.name) || names.has(t.name) || typeof t.description !== 'string' || t.description.length > 4000 || !object(t.parameters) || t.parameters.type !== 'object') fail('INPUT_INVALID');
    names.add(t.name);
  }
  let nonSystem = false;
  for (const m of messages) {
    if (!object(m) || !['system','user','assistant','tool'].includes(m.role) || typeof m.content !== 'string' || m.content.includes('\0') || Object.keys(m).some(k => !['role','content','toolCalls','toolCallId','name','providerContent'].includes(k))) fail('INPUT_INVALID');
    if (m.role === 'system' && nonSystem) fail('INPUT_INVALID');
    if (m.role !== 'system') nonSystem = true;
    if (m.role === 'tool' && (!idOK(m.toolCallId) || !nameOK(m.name))) fail('INPUT_INVALID');
    if (m.role !== 'assistant' && (m.toolCalls != null || m.providerContent != null)) fail('INPUT_INVALID');
    if (m.role !== 'tool' && (m.toolCallId != null || m.name != null)) fail('INPUT_INVALID');
  }
  if (!nonSystem || ['system','assistant'].includes(messages.at(-1).role)) fail('INPUT_INVALID');
  if (Buffer.byteLength(JSON.stringify({messages,tools})) > config.maxRequestBytes) fail('CHAT_CONTEXT_LIMIT');
}
function nativeGemini(content) {
  if (!object(content) || content.role !== 'model' || !Array.isArray(content.parts) || !content.parts.length || content.parts.length > 128 || Object.keys(content).some(k => !['role','parts'].includes(k))) fail();
  for (const p of content.parts) {
    if (!object(p) || Object.keys(p).some(k => !['text','thought','thoughtSignature','functionCall'].includes(k)) || p.text != null && typeof p.text !== 'string' || p.thought != null && typeof p.thought !== 'boolean' || p.thoughtSignature != null && typeof p.thoughtSignature !== 'string') fail();
    if (p.functionCall != null && (!object(p.functionCall) || Object.keys(p.functionCall).some(k => !['id','name','args'].includes(k)))) fail();
  }
  return structuredClone(content);
}
function nativeOllama(content) {
  if (!object(content) || content.role !== 'assistant' || typeof content.content !== 'string' || content.thinking != null && typeof content.thinking !== 'string' || Object.keys(content).some(k => !['role','content','thinking','tool_calls'].includes(k))) fail();
  if (content.tool_calls != null && (!Array.isArray(content.tool_calls) || content.tool_calls.some(c => !object(c?.function) || Object.keys(c).some(k => k !== 'function') || Object.keys(c.function).some(k => !['name','arguments','index'].includes(k))))) fail();
  return structuredClone(content);
}
function encodeMessages(messages, provider, model, tools, max) {
  const output = [], pending = new Map();
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role !== 'tool' && pending.size) fail('INPUT_INVALID');
    if (m.role === 'tool') {
      const item = pending.get(m.toolCallId);
      if (!item || item.name !== m.name) fail('INPUT_INVALID');
      let result; try { result = JSON.parse(m.content); } catch { fail('INPUT_INVALID'); }
      if (!object(result) || !jsonValue(result)) fail('INPUT_INVALID');
      pending.delete(m.toolCallId);
      if (provider === 'ollama') output.push({ role:'tool',tool_name:m.name,content:m.content });
      else {
        const part = { functionResponse: { ...(item.nativeId ? {id:item.nativeId} : {}), name:m.name, response:result } };
        if (output.at(-1)?.role === 'user' && output.at(-1).parts.some(p => p.functionResponse)) output.at(-1).parts.push(part);
        else output.push({role:'user',parts:[part]});
      }
      continue;
    }
    const native = m.role === 'assistant' && m.providerContent?.provider === provider && m.providerContent?.model === model;
    // Provider switches export only ordinary text; never signatures, thinking or native tool frames.
    if (!native && (m.toolCalls?.length ?? 0)) fail('INPUT_INVALID');
    if (m.role === 'assistant' && native) {
      const content = provider === 'gemini' ? nativeGemini(m.providerContent.content) : nativeOllama(m.providerContent.content);
      const raw = provider === 'gemini' ? content.parts.filter(p => p.functionCall).map(p => p.functionCall) : (content.tool_calls ?? []).map(c => ({name:c.function.name,args:c.function.arguments}));
      const common = checkedCalls(m.toolCalls ?? [], tools, max);
      if (raw.length !== common.length) fail('INPUT_INVALID');
      for (const [i, c] of common.entries()) {
        if (raw[i].name !== c.name || JSON.stringify(raw[i].args === undefined ? {} : raw[i].args) !== JSON.stringify(c.args)) fail('INPUT_INVALID');
        if (provider === 'gemini' && raw[i].id != null && (!idOK(raw[i].id) || raw[i].id !== c.id)) fail('INPUT_INVALID');
        pending.set(c.id,{name:c.name,nativeId:provider === 'gemini' ? raw[i].id : undefined});
      }
      output.push(content);
    } else if (m.content) output.push(provider === 'gemini' ? {role:m.role === 'assistant'?'model':'user',parts:[{text:m.content}]} : {role:m.role,content:m.content});
  }
  if (pending.size) fail('INPUT_INVALID');
  return output;
}
function observedUsage(data, provider) {
  const inputTokens=count(provider==='gemini'?data.usageMetadata?.promptTokenCount:data.prompt_eval_count);
  const outputTokens=count(provider==='gemini'?data.usageMetadata?.candidatesTokenCount:data.eval_count);
  return {inputTokens,outputTokens,totalTokens:provider==='gemini'?count(data.usageMetadata?.totalTokenCount):inputTokens!==null&&outputTokens!==null&&Number.isSafeInteger(inputTokens+outputTokens)?inputTokens+outputTokens:null,
    cachedTokens:count(provider==='gemini'?data.usageMetadata?.cachedContentTokenCount:data.prompt_eval_cached_count),thoughtTokens:provider==='gemini'?count(data.usageMetadata?.thoughtsTokenCount):null};
}

export class ChatProviders {
  constructor(config = {}, {fetchImpl = fetch, resolveSecret} = {}) {
    this.assistant=validateAssistantConfig(config.assistant); this.ollama=validateOllamaConfig(config.ollama); this.gemini=validateGeminiConfig(config.gemini);
    if(this.gemini.enabled&&[config.telegram?.tokenRef,config.actual?.passwordRef,config.actual?.encryptionPasswordRef,config.backup?.keyRef].includes(this.gemini.apiKeyRef)) fail('CONFIG_INVALID');
    this.external=config.privacy?.externalProviders === true; this.fetch=fetchImpl;
    this.resolveSecret=resolveSecret ?? secretResolver(config.secretDir);
  }
  settings(provider) {
    if (!this.assistant.enabled) fail('CHAT_DISABLED');
    if (!['ollama','gemini'].includes(provider)) fail('INPUT_INVALID');
    if (provider==='ollama'&&!this.ollama.enabled) fail('OLLAMA_DISABLED');
    if (provider==='gemini'&&(!this.gemini.enabled||!this.external)) fail('GEMINI_DISABLED');
    return this[provider];
  }
  async run(provider, work) {
    const c=this.settings(provider), controller=new AbortController(), timeout=provider==='ollama'?'OLLAMA_TIMEOUT':'GEMINI_TIMEOUT';
    let timer;
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new AppError(timeout));},c.timeoutMs);});
    const execute=async()=>{
      let key;
      if(provider==='gemini') {
        key=await this.resolveSecret(c.apiKeyRef);
        if(typeof key!=='string'||!key||/[\s\0]/.test(key)||key.length>16384) fail('SECRET_UNAVAILABLE');
      }
      const request=async(endpoint,body)=>{
        if(controller.signal.aborted) fail(timeout);
        const response=await this.fetch((provider==='gemini'?API:c.url)+endpoint,{method:body?'POST':'GET',headers:{...(body?{'content-type':'application/json'}:{}),...(key?{'x-goog-api-key':key}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal,redirect:'error'});
        if(!response.ok) {
          if(provider==='gemini'&&response.status===429) fail('GEMINI_RATE_LIMITED');
          if(provider==='gemini'&&response.status>=400&&response.status<500) fail('GEMINI_REJECTED');
          fail(provider==='gemini'?'GEMINI_UNAVAILABLE':'OLLAMA_UNAVAILABLE');
        }
        let data; try {data=await readJsonLimited(response,c.maxResponseBytes);} catch {fail('CHAT_INVALID_RESPONSE');}
        if(!object(data)||data.error||!jsonValue(data)) fail('CHAT_INVALID_RESPONSE');
        return data;
      };
      return work(request,c);
    };
    try {return await Promise.race([execute(),deadline]);}
    catch(e) {
      if(controller.signal.aborted) fail(timeout);
      if(e instanceof AppError && /^(CHAT_|OLLAMA_|GEMINI_|SECRET_|INPUT_INVALID)/.test(e.code)) throw e;
      fail(provider==='gemini'?'GEMINI_UNAVAILABLE':'OLLAMA_UNAVAILABLE');
    } finally {clearTimeout(timer);controller.abort();}
  }
  async listModels({provider}={}) {
    return this.run(provider,async(request,c)=>{
      if(provider==='ollama') {
        const entries=await localInventory(request), result=[], seen=new Set();
        for(const item of entries) {
          if(!safeLocalEntry(item)) continue;
          const id=canonicalModel(item.model??item.name);
          if(seen.has(id)) fail('OLLAMA_MODEL_UNSAFE'); seen.add(id);
          try {const info=localModelInfo(await request('/api/show',{model:id,verbose:false}),c.contextTokens,{tools:true});result.push({id,provider,tools:true,...info});}
          catch(e) {if(e?.code!=='OLLAMA_MODEL_UNSAFE') throw e;}
        }
        return result;
      }
      const result=[],seen=new Set(),pages=new Set();let page;
      for(let i=0;i<10;i++) {
        const data=await request('/models?pageSize=100'+(page?'&pageToken='+encodeURIComponent(page):''));
        if(!Array.isArray(data.models)||data.models.length>1000) fail();
        for(const m of data.models) {
          const id=typeof m?.name==='string'&&m.name.startsWith('models/')?m.name.slice(7):'';
          if(!validGeminiModel(id)||!Array.isArray(m.supportedGenerationMethods)) fail();
          if(m.supportedGenerationMethods.includes('generateContent')&&!seen.has(id)) {seen.add(id);result.push({id,provider,inputTokenLimit:count(m.inputTokenLimit),outputTokenLimit:count(m.outputTokenLimit)});}
        }
        if(!data.nextPageToken) return result;
        if(typeof data.nextPageToken!=='string'||data.nextPageToken.length>2048||pages.has(data.nextPageToken)) fail();
        page=data.nextPageToken;pages.add(page);
      }
      fail('CHAT_INVALID_RESPONSE');
    });
  }
  async complete({provider,model,messages,tools=[]}={}) {
    const c=this.settings(provider);model=model??c.model;
    if(provider==='gemini'&&!validGeminiModel(model)) fail('INPUT_INVALID');
    if(provider==='ollama') {try {validateOllamaConfig({...c,model});}catch {fail('INPUT_INVALID');}model=canonicalModel(model);}
    validateInput(messages,tools,this.assistant);
    const history=encodeMessages(messages,provider,model,tools,this.assistant.maxToolCalls), system=messages.filter(m=>m.role==='system').map(m=>m.content);
    const body=provider==='gemini'?{contents:history,...(system.length?{systemInstruction:{parts:system.map(text=>({text}))}}:{}),...(tools.length?{tools:[{functionDeclarations:tools.map(t=>({name:t.name,description:t.description,parametersJsonSchema:t.parameters}))}],toolConfig:{functionCallingConfig:{mode:'AUTO'}}}:{}),generationConfig:{maxOutputTokens:c.outputTokens,...(model==='gemini-3.8-flash'?{thinkingConfig:{thinkingLevel:'low'}}:{})}}:
      {model,messages:[...system.map(content=>({role:'system',content})),...history],stream:false,...(tools.length?{tools:tools.map(t=>({type:'function',function:t}))}:{}),keep_alive:'5m',options:{num_ctx:c.contextTokens,num_predict:this.assistant.outputTokens}};
    const bytes=Buffer.byteLength(JSON.stringify(body));
    if(bytes>this.assistant.maxRequestBytes||provider==='ollama'&&bytes+this.assistant.outputTokens+512>c.contextTokens) fail('CHAT_CONTEXT_LIMIT');
    const started=performance.now();
    return this.run(provider,async request=>{
      if(provider==='ollama') await requireLocalModel(request,model,c.contextTokens,{tools:true});
      else {
        const available=await request('/models/'+encodeURIComponent(model));
        if(available.name!=='models/'+model||!available.supportedGenerationMethods?.includes('generateContent')) fail('CHAT_MODEL_UNAVAILABLE');
        if(count(available.inputTokenLimit)!==null&&bytes>available.inputTokenLimit||count(available.outputTokenLimit)!==null&&c.outputTokens>available.outputTokenLimit) fail('CHAT_CONTEXT_LIMIT');
      }
      const data=await request(provider==='gemini'?'/models/'+encodeURIComponent(model)+':generateContent':'/api/chat',body);
      let raw, calls, text;
      if(provider==='gemini') {
        if(!Array.isArray(data.candidates)||data.candidates.length!==1||data.candidates[0].finishReason!=='STOP') fail();
        raw=nativeGemini(data.candidates[0].content);
        calls=checkedCalls(raw.parts.filter(p=>p.functionCall).map(p=>p.functionCall),tools,this.assistant.maxToolCalls,{native:true});
        text=raw.parts.filter(p=>typeof p.text==='string'&&!p.thought).map(p=>p.text).join('');
      } else {
        if(isRemoteModel(data)||data.done!==true||data.done_reason!=null&&data.done_reason!=='stop'||typeof data.model!=='string'||canonicalModel(data.model)!==model) fail();
        raw=nativeOllama(data.message);
        calls=checkedCalls((raw.tool_calls??[]).map(c=>({name:c.function.name,args:c.function.arguments})),tools,this.assistant.maxToolCalls,{native:true});
        text=raw.content;
      }
      if(!text.trim()&&!calls.length) fail();
      const assistantMessage={role:'assistant',content:text,toolCalls:calls,providerContent:{provider,model,content:raw}};
      return {text,toolCalls:calls,assistantMessage,usage:observedUsage(data,provider),provider,model,durationMs:Math.max(0,Math.round(performance.now()-started))};
    });
  }
}
