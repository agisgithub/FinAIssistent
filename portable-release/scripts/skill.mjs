#!/usr/bin/env node
// CLI administradora: reutiliza os scripts da IA, sem interpretador shell.
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadConfig} from '../src/config.mjs';
import {actualProfileConfig} from '../src/actual/base-registry.mjs';
import {ActualClient} from '../src/actual/client.mjs';
import {StateStore} from '../src/storage/store.mjs';
import {identityFromConfig} from '../src/policy/authorize.mjs';
import {FinanceTools} from '../src/application/assistant-tools.mjs';
import {SkillSession,SKILLS} from '../src/skills/runtime.mjs';
import {decodePngPhoto} from '../src/telegram/media.mjs';
import {errorCode} from '../src/errors.mjs';
process.umask(0o077);
const argv=process.argv.slice(2), options={}, names=[];
for(let i=0;i<argv.length;i++){if(argv[i].startsWith('--')){const key=argv[i].slice(2);if(!argv[i+1]||Object.hasOwn(options,key))throw Error('Argumentos inválidos');options[key]=argv[++i];}else names.push(argv[i]);}
if(names.length===1&&names[0]==='list'){console.log(JSON.stringify(SKILLS.map(({name,description})=>({name,description})),null,2));process.exit(0);}
const name=names[0],definition=SKILLS.find(s=>s.name===name);
if(names.length!==1||!definition||!options.base)throw Error('Uso: node scripts/skill.mjs --base ALIAS NOME --parameters JSON [--then render_chart --out arquivo.png]');
if(['prepare_category_changes','record_financial_memory','manage_financial_goal'].includes(name))throw Error('Propostas exigem o contexto autenticado de um pedido no Telegram; a CLI é somente leitura.');
let args=JSON.parse(options.parameters??'{}');
for(const [key,value] of Object.entries(options))if(!['base','parameters','then','out'].includes(key)){if(!definition.parameters.properties[key])throw Error('Parâmetro desconhecido');args[key]=definition.parameters.properties[key].type==='string'?value:JSON.parse(value);}
const base=actualProfileConfig(await loadConfig(),options.base),identity=identityFromConfig(base);
const config={...base,dataDir:await fs.mkdtemp(path.join(base.dataDir,'skill-run-'))};
const actual=new ActualClient(config),store=new StateStore(path.join(base.dataDir,'state.sqlite'),identity,{conversationConfig:base});
const session=new SkillSession({config,store,actual,tools:new FinanceTools({config,store,actual})});
try{
  const context={identity,allowedTransactionIds:new Set()};
  let result=await session.execute({name,args},context);
  if(options.then){if(options.then!=='render_chart')throw Error('CLI --then suporta render_chart; outras composições usam a API de skills');result=await session.execute({name:'render_chart',args:{},inputRef:result.data.resultRef},context);}
  if(options.out){if(!result.message?.photo)throw Error('Sem gráfico para exportar');await fs.writeFile(options.out,decodePngPhoto(result.message.photo).bytes,{flag:'wx',mode:0o600});}
  console.log(JSON.stringify({data:result.data,text:result.message?.text,hasChart:!!result.message?.photo,output:options.out??null},null,2));
}catch(error){console.error(JSON.stringify({error:errorCode(error),financialWriteExecuted:false}));process.exitCode=1;}
finally{store.close();await actual.close();}
