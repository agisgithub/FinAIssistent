// Host CLI: Node 24 standard library + Docker CLI; no npm install on host.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const docker=process.platform==='win32'?'docker.exe':'docker';
const components={actual:'actual-data',aig:'aig-data',state:'state',settings:'settings'};
function options(args){const result={};for(let i=0;i<args.length;i++){if(!args[i].startsWith('--')||!args[i+1]||args[i+1].startsWith('--'))throw Error('OPTION_INVALID');result[args[i].slice(2)]=args[++i];}return result;}
async function run(args,{capture=false,env={}}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(docker,args,{cwd:root,env:{...process.env,...env},stdio:capture?['ignore','pipe','inherit']:'inherit'});let text='';
    child.stdout?.on('data',chunk=>text+=chunk);child.on('error',()=>reject(Error('DOCKER_UNAVAILABLE')));
    child.on('close',code=>code?reject(Error('DOCKER_COMMAND_FAILED')):resolve(text.trim()));
  });
}
async function settings(){
  let text='';try{text=await fs.readFile(path.join(root,'.env'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  const values={};for(const line of text.split(/\r?\n/)){const m=/^([A-Z_]+)=(.*)$/.exec(line);if(m)values[m[1]]=m[2];}
  const project=process.env.FINAI_PROJECT??values.FINAI_PROJECT??'finaig';
  if(!/^[a-z][a-z0-9_-]{0,39}$/.test(project))throw Error('PROJECT_INVALID');
  return {...values,FINAI_PROJECT:project};
}
function publicURL(value){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.port!=='3443'||!/^[A-Za-z0-9.-]+$/.test(url.hostname))throw Error('USE_HTTPS_HOST_PORT_3443');return url.origin;}
async function saveEnv(values){await fs.writeFile(path.join(root,'.env'),Object.entries(values).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600});}
const compose=(env,...args)=>run(['compose','--env-file',path.join(root,'.env'),'-f','compose.portable.yaml',...args],{env});
async function build(env){
  await run(['build','--target','runtime','-t',env.FINAI_PROJECT+':portable-local','.']);
  await run(['build','--build-arg','APP_IMAGE='+env.FINAI_PROJECT+':portable-local','-f','portable/Dockerfile.tools','-t',env.FINAI_PROJECT+':portable-tools','.']);
}
async function helper(env,command,{mounts=[],network='none',args=[],capture=false,tmpfs='2g'}={}){
  return run(['run','--rm','--init','--network',network,'--read-only','--user','0:0','--env','FINAI_LOCAL_OLLAMA_HOST=ollama','--env','FINAI_EXPORT_UID='+(process.getuid?.()??1000),'--env','FINAI_EXPORT_GID='+(process.getgid?.()??1000),'--tmpfs','/tmp:rw,nosuid,nodev,size='+tmpfs,...mounts.flatMap(m=>['--mount',m]),env.FINAI_PROJECT+':portable-tools',command,...args],{capture});
}
const mountedTargets=env=>Object.entries(components).map(([dir,name])=>'type=volume,source='+env.FINAI_PROJECT+'_'+name+',target=/dest/'+dir);
async function createVolumes(env){for(const name of [...Object.values(components),'actual-cache','ollama-data'])await run(['volume','create','--label','com.docker.compose.project='+env.FINAI_PROJECT,'--label','com.docker.compose.volume='+name,env.FINAI_PROJECT+'_'+name],{capture:true});}
async function bundleMounts(o){
  if(!o.bundle||!o.key)throw Error('USE_BUNDLE_AND_KEY');
  const bundle=await fs.realpath(o.bundle),key=await fs.realpath(o.key);
  if(bundle.includes(',')||key.includes(','))throw Error('PATH_WITH_COMMA_NOT_SUPPORTED');
  return ['type=bind,source='+bundle+',target=/input,readonly','type=bind,source='+key+',target=/input-key/key,readonly'];
}
async function model(env){
  return helper(env,'models',{mounts:['type=volume,source='+env.FINAI_PROJECT+'_settings,target=/settings,readonly'],capture:true});
}
async function pullModel(env){
  const name=await model(env);if(!/^[A-Za-z0-9._/:-]+$/.test(name)||/(^|[-:/.])cloud($|[-:/.])/i.test(name))throw Error('LOCAL_MODEL_INVALID');
  await compose(env,'up','-d','ollama');
  await compose(env,'exec','-T','ollama','ollama','pull',name);
}
async function main(){
  if(Number(process.versions.node.split('.')[0])!==24)throw Error('NODE_24_REQUIRED');
  const [command='help',...rest]=process.argv.slice(2),o=options(rest);let env=await settings();
  if(command==='help'){console.log('FinAI portátil\nrestore --bundle PASTA --key ARQUIVO --url https://HOST:3443\nverify --bundle PASTA --key ARQUIVO\nsetup --url https://HOST:3443\nstart | status | models | stop | test\nactivate --confirm SOURCE_BOT_STOPPED\nbackup --out PASTA --key-dir PASTA\nO bot nunca inicia com start. Restore recusa volumes com dados.');return;}
  await run(['info','--format','{{.ServerVersion}}'],{capture:true});await run(['compose','version'],{capture:true});
  if(!['restore','verify','setup','build','start','status','models','stop','activate','backup','test'].includes(command))throw Error('COMMAND_INVALID');
  if(command==='restore'||command==='setup'){
    // Do not rewrite an existing installation's .env on a failed restore.
    try{await fs.access(path.join(root,'.env'));throw Error('USE_NEW_DIRECTORY_FOR_RESTORE_OR_SETUP');}catch(error){if(error.code!=='ENOENT')throw error;}
    env.FINAI_PUBLIC_URL=publicURL(o.url??'https://localhost:3443');
    // Binding on all interfaces is deliberate only for an explicitly supplied LAN hostname.
    env.FINAI_BIND=new URL(env.FINAI_PUBLIC_URL).hostname==='localhost'?'127.0.0.1':'0.0.0.0';
    env.FINAI_LOCAL_MODEL='qwen3:4b-instruct-2507-q4_K_M';
    await saveEnv(env);await build(env);await createVolumes(env);
  }else{try{await fs.access(path.join(root,'.env'));}catch{await saveEnv(env);}}
  if(command==='restore'){
    const running=await run(['ps','--filter','label=com.docker.compose.project='+env.FINAI_PROJECT,'--format','{{.Names}}'],{capture:true});
    if(running)throw Error('DESTINATION_CONTAINERS_RUNNING');
    await helper(env,'restore',{mounts:[...await bundleMounts(o),...mountedTargets(env)],args:[env.FINAI_PUBLIC_URL]});
    console.log('RESTORED: dados verificados; bot parado. Próximo: finai start.');return;
  }
  if(command==='verify'){await build(env);await helper(env,'verify',{mounts:await bundleMounts(o)});return;}
  if(command==='setup'){
    await compose(env,'up','-d','actual','actual-aig');
    console.log('Abra http://localhost:5006, crie/importe seu orçamento e obtenha o Sync ID. Informe http://actual:5006 no formulário a seguir.');
    await run(['run','--rm','-it','--user','0:0','--network',env.FINAI_PROJECT+'_default','--mount','type=volume,source='+env.FINAI_PROJECT+'_settings,target=/setup','--entrypoint','node',env.FINAI_PROJECT+':portable-local','scripts/setup-docker.mjs']);
    await helper(env,'configure-new',{mounts:mountedTargets(env),args:[env.FINAI_PUBLIC_URL]});return;
  }
  if(command==='build'){await build(env);return;}
  if(command==='models'){await pullModel(env);return;}
  if(command==='start'){await compose(env,'up','-d','actual','actual-aig','ollama');await pullModel(env);console.log('Actual e IA local iniciados. Telegram permanece parado até activate.');return;}
  if(command==='status'){await compose(env,'--profile','telegram','ps','-a');return;}
  if(command==='stop'){await compose(env,'--profile','telegram','stop');return;}
  if(command==='activate'){
    if(o.confirm!=='SOURCE_BOT_STOPPED')throw Error('STOP_SOURCE_BOT_BEFORE_ACTIVATE');
    await compose(env,'up','-d','actual','actual-aig','ollama');
    await pullModel(env);await compose(env,'--profile','telegram','up','-d','bot');return;
  }
  if(command==='test'){
    await run(['build','--target','verify','-t',env.FINAI_PROJECT+':portable-verify','.']);
    await run(['run','--rm','--network','none',env.FINAI_PROJECT+':portable-verify']);return;
  }
  if(command==='backup'){
    if(!o.out||!o['key-dir'])throw Error('USE_OUT_AND_KEY_DIR');
    const output=path.resolve(o.out),keys=path.resolve(o['key-dir']);
    if(output===keys||keys.startsWith(output+path.sep))throw Error('KEEP_KEY_SEPARATE');
    await fs.mkdir(output,{recursive:true,mode:0o700});await fs.mkdir(keys,{recursive:true,mode:0o700});
    if((await fs.readdir(output)).length)throw Error('OUTPUT_NOT_EMPTY');
    const ids=(await run(['ps','--filter','label=com.docker.compose.project='+env.FINAI_PROJECT,'--format','{{.ID}}'],{capture:true})).split('\n').filter(Boolean);
    try{
      if(ids.length)await run(['stop','--time','45',...ids]);
      const mounts=Object.entries(components).map(([dir,name])=>'type=volume,source='+env.FINAI_PROJECT+'_'+name+',target=/source/'+dir+',readonly');
      await helper(env,'backup',{mounts:[...mounts,'type=bind,source='+output+',target=/output','type=bind,source='+keys+',target=/key-output']});
    }finally{if(ids.length)await run(['start',...ids]);}
    console.log('Backup criptografado criado. Guarde a chave separadamente.');return;
  }
}
main().catch(error=>{console.error('FINAI_FAILED '+(error.code??error.message??'UNKNOWN'));process.exitCode=1;});
