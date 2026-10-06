import path from 'node:path';
import { validateConfig } from '../config.mjs';
import { DEFAULT_GEMINI_MODEL } from '../llm/chat-config.mjs';
import { RegistrationError, fingerprint } from './store.mjs';

const bad = message => {throw new RegistrationError('FORM_INVALID',message);};
const clean = (value,max=200) => typeof value==='string'&&value.length<=max&&!/[\x00-\x1f]/.test(value)?value.trim():'';
const secret = value => value == null || value === '' ? '' : typeof value==='string' && value.length<=4096 && !/[\x00-\x1f]/.test(value) ? value : bad('Uma das credenciais tem formato inválido.');
export function webSettings(base,env=process.env) {
  const publicUrl=new URL(env.ONBOARDING_PUBLIC_URL??'https://10.11.46.109:3443');
  if(!['https:','http:'].includes(publicUrl.protocol)||publicUrl.username||publicUrl.password||publicUrl.search||publicUrl.hash||publicUrl.pathname!=='/')throw Error('ONBOARDING_PUBLIC_URL_INVALID');
  if(publicUrl.protocol==='http:'&&env.ONBOARDING_ALLOW_HTTP!=='true')throw Error('ONBOARDING_HTTP_NOT_ENABLED');
  const allowedServers=[...new Set([
    ...Object.values(base.actual.bases??{principal:base.actual}).map(p=>p.serverURL),
    ...(env.ONBOARDING_ACTUAL_URLS??'http://127.0.0.1:5006,http://127.0.0.1:5007,http://localhost:5006,http://localhost:5007').split(',').filter(Boolean)
  ].map(url=>new URL(url).href.replace(/\/$/,'')))];
  return {
    publicUrl:publicUrl.origin,host:env.ONBOARDING_BIND??'0.0.0.0',port:Number(env.ONBOARDING_PORT??publicUrl.port??3443)||3443,
    allowedServers,dataDir:path.join(base.dataDir,'onboarding'),secretRoot:env.ONBOARDING_TEMP_SECRET_DIR??'/tmp/finaissistent-onboarding',
    keyFile:env.ONBOARDING_KEY_FILE??path.join(base.secretDir,'onboarding-key'),
    certFile:env.ONBOARDING_TLS_CERT??path.join(base.secretDir,'onboarding-cert.pem'),
    tlsKeyFile:env.ONBOARDING_TLS_KEY??path.join(base.secretDir,'onboarding-key.pem'),
    maxUsers:Number(env.ONBOARDING_MAX_USERS??20),geminiModel:base.gemini?.model??DEFAULT_GEMINI_MODEL,
    localEnabled:base.ollama?.enabled===true, legacyUserId:base.telegram.userId,
    pilotUntil:Date.parse(env.ONBOARDING_PILOT_UNTIL??'1970-01-01'),
  };
}
export function buildRegistration(input,invite,{base,settings,existing=null,secrets={}}) {
  const fields=['displayName','serverURL','budgetId','actualPassword','encryptionPassword','apiKey','provider','model','timezone','allowEdits','cloudConsent','dailyReconciliation','reconciliationTime'];
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.includes(key)))bad('Campos do formulário inválidos.');
  const displayName=clean(input.displayName,80)||invite.display_name||'Você';
  const serverURL=clean(input.serverURL,300).replace(/\/$/,'');
  if(!settings.allowedServers.includes(serverURL))bad('Escolha um servidor Actual habilitado neste piloto.');
  const budgetId=clean(input.budgetId,128);
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(budgetId))bad('Informe o Sync ID do orçamento.');
  if(!['gemini','ollama'].includes(input.provider))bad('Escolha o provedor de IA.');
  if(input.provider==='ollama'&&!settings.localEnabled)bad('O modelo local está desativado neste servidor.');
  if(input.provider==='gemini'&&input.cloudConsent!==true)bad('Autorize o envio das perguntas e dos dados consultados à IA.');
  if(typeof input.allowEdits!=='boolean')bad('Escolha a permissão de edição.');
  const identityKey=fingerprint(`${serverURL}:${budgetId}`).slice(0,16);
  // Existing owner retains both named budgets. Only the selected default profile is updated.
  const owner=invite.user_id===base.telegram.userId;
  const previous=existing?.config??(owner?base:null);
  const defaultBase=previous?.actual.defaultBase??'principal';
  const dailyOn=input.dailyReconciliation??false,time=input.reconciliationTime??'09:00';
  if(typeof dailyOn!=='boolean'||typeof time!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))bad('Confira o horário do conciliador diário.');
  const bases=structuredClone(previous?.actual.bases??{});
  const current=bases[defaultBase];
  const same=current?.serverURL===serverURL&&current?.budgetId===budgetId;
  if(owner&&current&&!same)bad('Para mudar o orçamento do administrador, use /base usar ALIAS antes do cadastro. Este formulário preserva as bases existentes.');
  const password=secret(input.actualPassword)||((same&&current?.passwordRef)?secrets[current.passwordRef]:null);
  if(!password)bad('Informe a senha do servidor Actual.');
  const passwordRef=`onboard-actual-${defaultBase}`,encryptionRef=`onboard-encryption-${defaultBase}`;
  const vault={...secrets,[passwordRef]:password};
  const encryption=secret(input.encryptionPassword)||((same&&current?.encryptionPasswordRef)?secrets[current.encryptionPasswordRef]:null);
  if(encryption)vault[encryptionRef]=encryption;
  const provider=input.provider,model=clean(input.model,160)||settings.geminiModel;
  if(provider==='gemini') {
    const key=secret(input.apiKey)||secrets[previous?.gemini?.apiKeyRef];
    if(!key)bad('Informe sua chave da API Gemini.');
    vault['onboard-gemini-key']=key;
  }
  bases[defaultBase]={serverURL,budgetId,passwordRef,encryptionPasswordRef:encryption?encryptionRef:null,timeoutMs:120000};
  const config=validateConfig({
    householdId:owner?base.householdId:`tg-${invite.user_id}`,
    telegram:{userId:invite.user_id,chatId:invite.chat_id,tokenRef:base.telegram.tokenRef},
    timezone:clean(input.timezone,80)||'America/Sao_Paulo',currency:'BRL',
    dataDir:owner?base.dataDir:path.join(settings.dataDir,'users',`u${invite.user_id}`,identityKey),
    secretDir:path.join(settings.secretRoot,`u${invite.user_id}`),
    actual:{defaultBase,bases},dryRun:!input.allowEdits,retentionDays:previous?.retentionDays??90,
    privacy:{externalProviders:provider==='gemini'},
    gemini:{enabled:provider==='gemini',model,apiKeyRef:provider==='gemini'?'onboard-gemini-key':null},
    ollama:base.ollama,assistant:base.assistant,backup:{keyRef:owner&&base.backup?.keyRef?base.backup.keyRef:'onboard-backup-key'},
    categorization:previous?.categorization,
    companion:{...base.companion,enabled:true,transactionMonitorEnabled:dailyOn||(owner&&previous.companion.transactionMonitorEnabled),autoCategorizeHighConfidence:input.allowEdits&&(dailyOn||(owner&&previous.companion.autoCategorizeHighConfidence))},
  });
  return {displayName,config,secrets:vault,provider,reconciliation:{enabled:dailyOn,time},cloudConsent:provider==='gemini',consentedAt:new Date().toISOString()};
}
export function publicDefaults(payload,base,settings,invite) {
  const cfg=payload?.config??(invite.user_id===base.telegram.userId?base:null);
  const profile=cfg?.actual.bases?.[cfg.actual.defaultBase]??cfg?.actual;
  return {displayName:payload?.displayName??invite.display_name,servers:settings.allowedServers,serverURL:profile?.serverURL??settings.allowedServers[0],budgetId:profile?.budgetId??'',timezone:cfg?.timezone??'America/Sao_Paulo',provider:payload?.provider??'gemini',model:cfg?.gemini?.model??settings.geminiModel,allowEdits:cfg?cfg.dryRun===false:true,hasPassword:!!cfg,hasApiKey:cfg?.gemini?.enabled===true,hasEncryption:!!profile?.encryptionPasswordRef,localEnabled:settings.localEnabled,expiresAt:invite.expires_at,dailyReconciliation:payload?.reconciliation?.enabled??true,reconciliationTime:payload?.reconciliation?.time??'09:00'};
}
