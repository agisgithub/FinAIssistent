import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ActualClient } from '../actual/client.mjs';
import { actualSecretReferences } from '../actual/base-registry.mjs';
import { secretResolver } from '../secrets/resolver.mjs';
import { ChatProviders } from '../llm/chat.mjs';
import { validateConfig } from '../config.mjs';
import { buildRegistration,publicDefaults } from './settings.mjs';
import { RegistrationError } from './store.mjs';

export async function writeRuntimeSecrets(directory,secrets) {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  for(const [name,value] of Object.entries(secrets)) {
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name)||typeof value!=='string')throw Error('SECRET_INVALID');
    const target=path.join(directory,name),temporary=target+'.tmp';
    await fs.writeFile(temporary,value,{mode:0o600});await fs.rename(temporary,target);
  }
}
export class RegistrationService {
  constructor({base,settings,store,activate,effectiveConfig=()=>base,validateConnection}) {
    Object.assign(this,{base,settings,store,activate,effectiveConfig});
    this.validateConnection=validateConnection??this.validateActualAndModel.bind(this);
    this.inflight=new Set();
  }
  defaults(token) {
    const invite=this.store.invite(token);
    const existing=this.store.tenant(invite.user_id);
    const effective=this.effectiveConfig(invite.user_id)??existing?.config??this.base;
    return publicDefaults(existing?{...existing,config:effective}:null,effective,this.settings,invite);
  }
  async validateActualAndModel(payload,tempDir) {
    const c={...payload.config,dataDir:path.join(tempDir,'cache'),secretDir:path.join(tempDir,'secrets')};
    await writeRuntimeSecrets(c.secretDir,payload.secrets);
    const profile=c.actual.bases[c.actual.defaultBase];
    const actual=new ActualClient({...c,actual:profile,dryRun:true});
    try {await actual.inspectCategoryCatalog();}
    catch (error) {throw new RegistrationError(error?.code==='ACTUAL_CLOCK_DRIFT'?'ACTUAL_CLOCK_DRIFT':'ACTUAL_CONNECTION',error?.code==='ACTUAL_CLOCK_DRIFT'?'O relógio do servidor está incompatível com o orçamento (clock-drift). Corrija a sincronização de horário do Debian; não altere as datas dos lançamentos.':'Não consegui abrir esse orçamento. Confira servidor, senha, Sync ID e senha de criptografia.',422);}
    finally {await actual.close();}
    try {
      const providers=new ChatProviders(c,{resolveSecret:secretResolver(c.secretDir)});
      const models=await providers.listModels({provider:payload.provider});
      if(!models.some(model=>model.id===c[payload.provider].model))throw Error('MODEL_UNAVAILABLE');
    }catch {throw new RegistrationError('AI_CONNECTION',payload.provider==='gemini'?'Não consegui validar a chave e o modelo Gemini. Confira sua API key e o nome do modelo.':'Não consegui acessar o modelo local. Tente mais tarde ou escolha Gemini.',422);}
  }
  async register(token,code,input) {
    const invite=this.store.claim(token,code);
    if(this.inflight.has(invite.user_id)){this.store.release(token);throw new RegistrationError('BUSY','Seu cadastro já está sendo validado.',409);}
    this.inflight.add(invite.user_id);
    let temporary,committed=false;
    try {
      const existing=this.store.tenant(invite.user_id);
      if(!existing&&invite.user_id!==this.base.telegram.userId&&this.store.tenants().length>=this.settings.maxUsers)throw new RegistrationError('PILOT_FULL','O piloto atingiu o limite de usuários.',409);
      let secrets=existing?.secrets??{};
      const effective=this.effectiveConfig(invite.user_id)??existing?.config??this.base;
      if(invite.user_id===this.base.telegram.userId&&!existing) {
        const resolve=secretResolver(this.base.secretDir);
        const refs=[...actualSecretReferences(this.base.actual),this.base.gemini?.apiKeyRef,this.base.backup?.keyRef].filter(Boolean);
        secrets=Object.fromEntries(await Promise.all([...new Set(refs)].map(async ref=>[ref,await resolve(ref)])));
      }
      const payload=buildRegistration(input,invite,{base:invite.user_id===this.base.telegram.userId?effective:this.base,settings:this.settings,existing:existing?{...existing,config:effective}:null,secrets});
      payload.secrets['onboard-backup-key']??=randomBytes(32).toString('hex');
      await fs.mkdir(this.settings.secretRoot,{recursive:true,mode:0o700});
      temporary=await fs.mkdtemp(path.join(this.settings.secretRoot,'validation-'));
      await this.validateConnection(payload,temporary);
      this.store.save(token,payload);committed=true;
      await this.activate({...payload,userId:invite.user_id});
      return {ok:true,name:payload.displayName,message:'Cadastro salvo e conexão validada. Volte ao Telegram para conversar.'};
    }catch(error) {
      if(!committed)this.store.release(token);
      if(error instanceof RegistrationError)throw error;
      throw new RegistrationError(committed?'ACTIVATION_PENDING':'REGISTRATION_FAILED',committed?'Cadastro salvo. A ativação está pendente; o bot tentará novamente na reinicialização.':'Não consegui concluir o cadastro. Revise os campos e tente novamente.',503);
    }finally {
      this.inflight.delete(invite.user_id);
      if(temporary&&path.dirname(temporary)===path.resolve(this.settings.secretRoot))await fs.rm(temporary,{recursive:true,force:true});
    }
  }
  async materialize(payload) {
    await writeRuntimeSecrets(payload.config.secretDir,payload.secrets);
    return validateConfig(payload.config);
  }
}
