import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateConfig } from '../config.mjs';
import { configDiagnostic } from '../config-diagnostics.mjs';
import { ChatProviders, GEMINI_PRIVACY_NOTICE } from '../llm/chat.mjs';
import { validateAssistantConfig, validateGeminiConfig } from '../llm/chat-config.mjs';
import { validateOllamaConfig } from '../llm/config.mjs';
import { commitSetup, setupFiles } from './wizard.mjs';
import { SetupCancelled } from './terminal.mjs';
import { actualSecretReferences } from '../actual/base-registry.mjs';

const {directory,regular,secretValue,yes,askValue}=setupFiles;
const fail=code=>{throw new Error(code);};
const refOK=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
export async function runAISetup({root=process.cwd(),io,owner=process.getuid?.()??1000,providersFactory=(c,options)=>new ChatProviders(c,options),commit=commitSetup}={}) {
  const privateRoot=path.join(root,'.setup-private'),secretRoot=path.join(root,'secrets');let stage,createdPrivate=false;
  try {
    await directory(root);await directory(secretRoot);await directory(privateRoot);
    const originalConfig=await regular(path.join(root,'config.json'));
    if(!originalConfig) fail('SETUP_EXISTING_CONFIG_REQUIRED');
    let config;try{config=JSON.parse(originalConfig.bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{fail('SETUP_CONFIG_JSON_INVALID');}
    const original=validateConfig(config,root);
    // Docker maps root/secrets to /run/secrets. Custom secret directories require
    // the documented manual edit; never silently move or overwrite other secrets.
    if(config.secretDir!=null&&!['./secrets','/run/secrets'].includes(config.secretDir)) fail('SETUP_CUSTOM_SECRET_PATH_REQUIRES_MANUAL_SETUP');
    io.write('Configuração somente de IA. Actual, Telegram, backup, dryRun e override de rede serão preservados. Enter mantém valores; segredos ficam ocultos.');
    const assistant={...original.assistant};assistant.enabled=await yes(io,'Ativar conversa assistida?',assistant.enabled);
    let ollama={...original.ollama};ollama.enabled=await yes(io,'Ativar Ollama local como provedor padrão?',ollama.enabled);
    if(ollama.enabled) {
      ollama.url=await askValue(io,'URL do Ollama',ollama.url);
      ollama.allowPrivateAddress=await yes(io,'A URL usa um IP privado literal autorizado por você?',ollama.allowPrivateAddress);
      io.write('No servidor Ollama, configure OLLAMA_NO_CLOUD=1 e reinicie. Localhost sozinho não comprova execução local.');
      ollama.localOnlyConfirmed=await yes(io,'Confirma execução local e recursos cloud desativados no Ollama?',false);
      if(!ollama.localOnlyConfirmed) throw new SetupCancelled();
      // Discovery never sends conversation data. Inspect with the lowest supported
      // context so the operator can choose a model and then its actual capacity.
      const probe=validateOllamaConfig({...ollama,model:ollama.model??'setup-discovery',contextTokens:4096});
      let models=[];
      try {models=await providersFactory({...original,assistant:{...assistant,enabled:true},ollama:probe}).listModels({provider:'ollama'});}
      catch {io.write('Inventário local indisponível. O modelo será validado novamente antes de qualquer pergunta; nenhuma disponibilidade foi comprovada.');}
      if(models.length) {
        for(const m of models.slice(0,100)) io.write(`Modelo local com ferramentas: ${m.id}; contexto máximo informado=${m.contextTokens}.`);
        ollama.model=await askValue(io,'ID exato do modelo da lista',ollama.model??models[0].id);
        const selected=models.find(m=>m.id===ollama.model||m.id===ollama.model+':latest');
        if(!selected) fail('SETUP_MODEL_NOT_LISTED');
        const preferred=Math.min(32768,selected.contextTokens);
        io.write('O contexto inclui instruções, ferramentas e histórico. O aplicativo recusa excesso sem truncar a pergunta.');
        if(preferred<16384) io.write('Este modelo informa menos de 16384 tokens: consultas com várias parcelas e catálogo podem exceder o limite. Escolha outro modelo local para esse fluxo ou reduza a consulta explicitamente.');
        ollama.contextTokens=Number(await askValue(io,'Contexto em tokens (4096..'+preferred+')',String(preferred)));
        if(!Number.isSafeInteger(ollama.contextTokens)||ollama.contextTokens>selected.contextTokens) fail('SETUP_CONTEXT_EXCEEDS_MODEL');
      } else {
        ollama.model=await askValue(io,'ID exato do modelo local (verificação pendente)',ollama.model??'');
        ollama.contextTokens=Number(await askValue(io,'Contexto em tokens (4096..32768; confirme capacidade local)',String(ollama.contextTokens)));
      }
    }
    ollama=validateOllamaConfig(ollama);config.ollama=ollama;config.assistant=validateAssistantConfig(assistant);
    const gemini={...original.gemini};gemini.enabled=await yes(io,'Disponibilizar Gemini como opção explícita no Telegram?',gemini.enabled);
    const secrets=new Map();
    if(gemini.enabled) {
      io.write(GEMINI_PRIVACY_NOTICE);
      io.write('Crie uma chave de autorização atual no Google AI Studio (https://aistudio.google.com/api-keys). Faturamento é do projeto da API; uma assinatura Google pessoal não comprova esse estado.');
      gemini.apiKeyRef??='gemini-api-key';
      const reserved=[config.telegram.tokenRef,...actualSecretReferences(config),config.backup?.keyRef].filter(Boolean);
      if(!refOK(gemini.apiKeyRef)||reserved.includes(gemini.apiKeyRef)) fail('SETUP_SECRET_REFERENCES_MUST_BE_DISTINCT');
      const existing=await regular(path.join(secretRoot,gemini.apiKeyRef),16384);let saved;
      try{saved=secretValue(existing);}catch{saved=null;}
      let key;
      for(;;) {
        key=await io.ask('Chave Gemini (oculta)'+(saved?' [Enter mantém o arquivo atual]':'')+': ',{secret:true});
        if(!key&&saved) {key=saved;break;}
        if(typeof key==='string'&&key&&!/[\s\0]/.test(key)&&Buffer.byteLength(key)<=16383) break;
        io.write('Informe uma chave de uma linha, sem espaços.');
      }
      secrets.set(gemini.apiKeyRef,{original:existing,bytes:key===saved?existing.bytes:Buffer.from(key+'\n')});
      gemini.model=await askValue(io,'Modelo Gemini (ID exato)',gemini.model);
      validateGeminiConfig(gemini);
      let inventory;
      try {inventory=await providersFactory({...original,assistant:{...assistant,enabled:true},privacy:{externalProviders:true},gemini},{resolveSecret:async ref=>{if(ref!==gemini.apiKeyRef)fail('SETUP_UNSAFE_REFERENCE');return key;}}).listModels({provider:'gemini'});}
      catch {io.write('Chave/modelo Gemini com verificação pendente: a consulta de metadados falhou. Nenhuma pergunta nem dado financeiro foi enviado; revise a chave/projeto no AI Studio e use /ia modelos.');}
      if(inventory) {if(!inventory.some(m=>m.id===gemini.model))fail('SETUP_MODEL_NOT_LISTED');io.write('O catálogo autenticado confirmou suporte a generateContent para esse ID; disponibilidade de geração e cotas ainda dependem do projeto.');}
      io.write('Ativar aqui apenas disponibiliza a opção. O envio de contexto ainda exige confirmação no Telegram; não existe fallback remoto automático.');
    }
    config.gemini=validateGeminiConfig(gemini);config.privacy={externalProviders:gemini.enabled};validateConfig(config,root);
    io.write(`Resumo IA: conversa ${assistant.enabled?'ativada':'desativada'}; padrão Ollama; Ollama ${ollama.enabled?'configurado':'desativado'}; Gemini ${gemini.enabled?'configurado para seleção com confirmação':'desativado'}.`);
    if(!await yes(io,'Salvar somente essas configurações de IA e sua chave, se informada?',false)) throw new SetupCancelled();
    io.check?.();createdPrivate=await directory(privateRoot,{create:true});
    if(process.platform!=='win32'&&((await fs.lstat(privateRoot)).mode&0o077)) fail('SETUP_PRIVATE_DIRECTORY_PERMISSIONS');
    stage=path.join(privateRoot,'run-'+randomUUID());await fs.mkdir(stage,{mode:0o700});
    await commit({root,stage,configBytes:Buffer.from(JSON.stringify(config,null,2)+'\n'),originalConfig,secrets,owner});
    io.write('IA configurada. A aplicação usará o Ollama por padrão. Reinicie o bot e use /ia; a chave nunca deve ser enviada pelo Telegram.');
    return {status:'saved'};
  } catch(error) {
    if(error instanceof SetupCancelled){io.write('Configuração de IA cancelada; arquivos anteriores preservados.');return {status:'cancelled'};}
    const diagnostic=configDiagnostic(error);
    if(diagnostic) io.write(`Configuração inválida: campo ${diagnostic.field}; motivo ${diagnostic.reason}.`);
    else {const allowed=new Set(['SETUP_EXISTING_CONFIG_REQUIRED','SETUP_CONFIG_JSON_INVALID','SETUP_CUSTOM_SECRET_PATH_REQUIRES_MANUAL_SETUP','SETUP_SECRET_REFERENCES_MUST_BE_DISTINCT','SETUP_MODEL_NOT_LISTED','SETUP_CONTEXT_EXCEEDS_MODEL','SETUP_PRIVATE_DIRECTORY_PERMISSIONS','SETUP_CHANGED_DURING_PROMPTS','SETUP_SAVE_FAILED_ROLLED_BACK','SETUP_ROLLBACK_REQUIRED_PRIVATE_BACKUP','SETUP_UNSAFE_FILE','SETUP_UNSAFE_DIRECTORY']);io.write('Falha de configuração: '+(allowed.has(error?.message)?error.message:'SETUP_FAILED')+'.');}
    return {status:'failed'};
  } finally {
    if(stage&&path.dirname(stage)===privateRoot&&/^run-[a-f0-9-]{36}$/.test(path.basename(stage))) {
      const stat=await fs.lstat(stage).catch(()=>null);
      if(stat?.isDirectory()&&!stat.isSymbolicLink()) {for(const name of await fs.readdir(stage)){const target=path.join(stage,name),item=await fs.lstat(target);if(item.isFile()||item.isSymbolicLink()) await fs.unlink(target);}await fs.rmdir(stage);}
    }
    if(createdPrivate) await fs.rmdir(privateRoot).catch(()=>{});
  }
}
