// Runs in a disposable container, never a Telegram poller. Reuses the app's AES-GCM backup.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {writeEncryptedBackup,readEncryptedBackup} from '../src/backups/encrypted.mjs';
import {validateConfig} from '../src/config.mjs';
import {OnboardingStore} from '../src/onboarding/store.mjs';
const Database=createRequire(import.meta.url)('better-sqlite3');
process.umask(0o077);
const COMPONENTS=['actual','aig','state','settings'];
const LIMIT=512*1024*1024;
function requireEmpty(entries){if(entries.some(a=>a.length))throw Error('DESTINATION_NOT_EMPTY');}
async function processBytes(command,args,input=null,max=LIMIT){
  return await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['pipe','pipe','pipe']});let size=0,failed=false;const parts=[];
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>max){failed=true;child.kill();}else parts.push(chunk);});
    child.stderr.resume();child.on('error',reject);child.stdin.on('error',()=>{});
    child.on('close',code=>code||failed?reject(Error('SUBPROCESS_FAILED')):resolve(Buffer.concat(parts)));
    child.stdin.end(input??undefined);
  });
}
async function inventory(root){
  const files=[],databases=[];
  async function walk(dir){
    for(const name of (await fs.readdir(dir)).sort()){
      if(/[\r\n\t]/.test(name))throw Error('UNSAFE_FILENAME');
      const file=path.join(dir,name),stat=await fs.lstat(file),relative=path.relative(root,file).split(path.sep).join('/');
      if(stat.isSymbolicLink())throw Error('SYMLINK_NOT_SUPPORTED');
      if(stat.isDirectory()){await walk(file);continue;}
      if(!stat.isFile())throw Error('SPECIAL_FILE_NOT_SUPPORTED');
      const data=await fs.readFile(file);
      files.push({path:relative,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
      if(data.subarray(0,16).toString()==='SQLite format 3\0'){
        // WAL readers may need a shared-memory file even in readonly mode.
        // Inspect an isolated tmpfs copy, never create/checkpoint files in the source.
        const checkDir=await fs.mkdtemp('/tmp/finai-sqlite-'),checkFile=path.join(checkDir,'check.sqlite');
        await fs.copyFile(file,checkFile);
        for(const suffix of ['-wal','-shm'])try{await fs.copyFile(file+suffix,checkFile+suffix);}catch(error){if(error.code!=='ENOENT')throw error;}
        const db=new Database(checkFile,{readonly:true,fileMustExist:true});
        try{
          if(db.pragma('quick_check',{simple:true})!=='ok')throw Error('SQLITE_NOT_HEALTHY');
          const counts={};
          for(const {name:table} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
            counts[table]=db.prepare('SELECT COUNT(*) AS n FROM "'+table.replaceAll('"','""')+'"').get().n;
          }
          databases.push({path:relative,tables:counts});
        }finally{db.close();}
      }
    }
  }
  for(const component of COMPONENTS)await walk(path.join(root,component));
  return {files,databases};
}
export function mappedActual(url){
  const u=new URL(url);
  if(['actual','actual-aig'].includes(u.hostname))return u.origin;
  const host=u.hostname;
  if(!['localhost','127.0.0.1','host.docker.internal','10.11.46.109'].includes(host))throw Error('EXTERNAL_SERVER_REQUIRES_MAPPING');
  if(u.port==='5006')return 'http://actual:5006';
  if(u.port==='5007')return 'http://actual-aig:5006';
  throw Error('ACTUAL_PORT_REQUIRES_MAPPING');
}
function relocateConfig(input,{tenant=false}={}){
  const config=structuredClone(input);
  // Normalized saved configs can also contain a compatibility profile.
  if(config.actual.bases){
    for(const profile of Object.values(config.actual.bases))profile.serverURL=mappedActual(profile.serverURL);
    for(const key of ['serverURL','budgetId','passwordRef','encryptionPasswordRef','timeoutMs'])delete config.actual[key];
  }else config.actual.serverURL=mappedActual(config.actual.serverURL);
  if(config.ollama)config.ollama.url='http://ollama:11434';
  config.secretDir=tenant?'/tmp/finaissistent-onboarding/u'+config.telegram.userId:'/settings/secrets';
  if(!String(config.dataDir).startsWith('/data'))throw Error('DATA_PATH_REQUIRES_MAPPING');
  validateConfig(config);return config;
}
async function permissions(root,uid=1000,gid=1000){
  const stat=await fs.lstat(root);if(stat.isSymbolicLink())throw Error('UNSAFE_PATH');
  await fs.chown(root,uid,gid);await fs.chmod(root,stat.isDirectory()?0o700:0o600);
  if(stat.isDirectory())for(const name of await fs.readdir(root))await permissions(path.join(root,name),uid,gid);
}
async function certificate(settings,url){
  const host=new URL(url).hostname;
  if(!/^[A-Za-z0-9.-]+$/.test(host))throw Error('PUBLIC_HOST_INVALID');
  const secrets=path.join(settings,'secrets');await fs.mkdir(secrets,{recursive:true,mode:0o700});
  const isIP=/^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  await processBytes('openssl',['req','-x509','-nodes','-newkey','rsa:3072','-days','365','-keyout',path.join(secrets,'onboarding-key.pem'),'-out',path.join(secrets,'onboarding-cert.pem'),'-subj','/CN='+host,'-addext','subjectAltName='+(isIP?'IP:':'DNS:')+host]);
}
async function relocate(root,url){
  const settings=path.join(root,'settings'),filename=path.join(settings,'config.json');
  const original=JSON.parse(await fs.readFile(filename,'utf8'));
  await fs.writeFile(filename,JSON.stringify(relocateConfig(original),null,2)+'\n',{mode:0o600});
  const registry=path.join(root,'state/onboarding/registry.sqlite');
  try{
    await fs.access(registry);
    const key=Buffer.from((await fs.readFile(path.join(settings,'secrets/onboarding-key'),'utf8')).trim(),'base64');
    const db=new Database(registry,{fileMustExist:true});
    try{
      db.transaction(()=>{
        for(const row of db.prepare('SELECT user_id,sealed FROM tenants').all()){
          const saved=OnboardingStore.prototype.unseal.call({key},row.sealed,row.user_id);
          saved.config=relocateConfig(saved.config,{tenant:true});
          const sealed=OnboardingStore.prototype.seal.call({key},saved,row.user_id);
          db.prepare('UPDATE tenants SET sealed=? WHERE user_id=?').run(sealed,row.user_id);
        }
        // Expire old browser invitations/sessions; never replay links from the old IP.
        db.prepare("UPDATE invites SET state='replaced' WHERE state IN ('pending','validating')").run();
        db.prepare("UPDATE gateway_outbox SET state='failed' WHERE state IN ('pending','sending')").run();
        const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
        if(tables.has('dashboard_sessions'))db.prepare('DELETE FROM dashboard_sessions').run();
        if(tables.has('dashboard_links'))db.prepare('DELETE FROM dashboard_links').run();
      })();
    }finally{db.close();key.fill(0);}
  }catch(error){if(error.code!=='ENOENT')throw error;}
  await certificate(settings,url);
  for(const component of COMPONENTS)await permissions(path.join(root,component));
  return {model:original.ollama?.model??'qwen3:4b-instruct-2507-q4_K_M'};
}
export async function backup(source,output){
  await fs.mkdir(output,{recursive:true,mode:0o700});
  requireEmpty([await fs.readdir(output)]);
  const key=randomBytes(32).toString('hex');
  const report=await inventory(source);
  const archiveManifest={version:1,createdAt:new Date().toISOString(),components:COMPONENTS,...report};
  const temporary=await fs.mkdtemp('/tmp/finai-manifest-');
  await fs.writeFile(path.join(temporary,'archive-manifest.json'),JSON.stringify(archiveManifest),{mode:0o600});
  const config={householdId:'portable',actual:{budgetId:'environment'},dataDir:output,backup:{keyRef:'migration'}};
  let bytes;
  try{
    bytes=await processBytes('tar',['-czf','-','-C',source,...COMPONENTS,'-C',temporary,'archive-manifest.json']);
    const reference=await writeEncryptedBackup(bytes,{config,operationId:'portable-migration',kind:'state',resolveSecret:async()=>key});
    await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify({version:1,format:'finai-portable',reference,createdAt:archiveManifest.createdAt,components:COMPONENTS},null,2)+'\n',{mode:0o600,flag:'wx'});
    await fs.writeFile('/key-output/chave-migracao.key',key+'\n',{mode:0o600,flag:'wx'});
    const uid=Number(process.env.FINAI_EXPORT_UID??1000),gid=Number(process.env.FINAI_EXPORT_GID??1000);
    if(!Number.isSafeInteger(uid)||uid<0||!Number.isSafeInteger(gid)||gid<0)throw Error('EXPORT_OWNER_INVALID');
    await permissions(output,uid,gid);await permissions('/key-output',uid,gid);
    console.log(JSON.stringify({encrypted:true,files:report.files.length,databases:report.databases.length,bytes:reference.bytes,financialWrites:0}));
  }finally{bytes?.fill(0);}
}
export async function restore(input,keyFile,destination,url,{verifyOnly=false}={}){
  const metadata=JSON.parse(await fs.readFile(path.join(input,'manifest.json'),'utf8'));
  if(metadata.version!==1||metadata.format!=='finai-portable')throw Error('BUNDLE_FORMAT_INVALID');
  const key=(await fs.readFile(keyFile,'utf8')).trim();if(!/^[a-f0-9]{64}$/i.test(key))throw Error('KEY_INVALID');
  // Private copy of ciphertext accommodates Windows bind-mount mode semantics.
  const privateInput=await fs.mkdtemp('/tmp/finai-cipher-');await fs.mkdir(path.join(privateInput,'backups'),{mode:0o700});
  const id=metadata.reference.id;if(!/^[a-f0-9-]{36}$/.test(id))throw Error('REFERENCE_INVALID');
  await fs.copyFile(path.join(input,'backups',id+'.bin'),path.join(privateInput,'backups',id+'.bin'));
  await fs.chmod(path.join(privateInput,'backups',id+'.bin'),0o600);
  const config={householdId:'portable',actual:{budgetId:'environment'},dataDir:privateInput,backup:{keyRef:'migration'}};
  let bytes;
  try{
    bytes=await readEncryptedBackup(metadata.reference,{config,resolveSecret:async()=>key});
    const listing=(await processBytes('tar',['-tzf','-'],bytes,16*1024*1024)).toString().split('\n').filter(Boolean);
    for(const file of listing){
      const parts=file.replace(/\/$/,'').split('/');
      if(file.startsWith('/')||parts.some(p=>['..','.',''].includes(p))||(!COMPONENTS.includes(parts[0])&&file!=='archive-manifest.json'))throw Error('UNSAFE_ARCHIVE');
    }
    const detailed=(await processBytes('tar',['-tvzf','-'],bytes,32*1024*1024)).toString().split('\n').filter(Boolean);
    if(detailed.some(line=>!['d','-'].includes(line[0])))throw Error('ARCHIVE_LINK_NOT_ALLOWED');
    const stage=await fs.mkdtemp('/tmp/finai-stage-');
    await processBytes('tar',['-xzf','-','-C',stage,'--no-same-owner','--no-same-permissions'],bytes);
    const expected=JSON.parse(await fs.readFile(path.join(stage,'archive-manifest.json'),'utf8'));
    const observed=await inventory(stage);
    if(JSON.stringify(expected.files)!==JSON.stringify(observed.files)||JSON.stringify(expected.databases)!==JSON.stringify(observed.databases))throw Error('RESTORE_VERIFICATION_FAILED');
    if(verifyOnly){console.log(JSON.stringify({authenticated:true,verified:true,files:observed.files.length,databases:observed.databases.length,financialWrites:0}));return;}
    requireEmpty(await Promise.all(COMPONENTS.map(c=>fs.readdir(path.join(destination,c)))));
    const relocated=await relocate(stage,url);
    for(const component of COMPONENTS)for(const name of await fs.readdir(path.join(stage,component))){
      await fs.cp(path.join(stage,component,name),path.join(destination,component,name),{recursive:true,force:false,errorOnExist:true});
    }
    for(const component of COMPONENTS)await permissions(path.join(destination,component));
    const after=await inventory(destination);
    const finance=list=>list.filter(x=>x.path.startsWith('actual/')||x.path.startsWith('aig/'));
    if(JSON.stringify(finance(after.files))!==JSON.stringify(finance(expected.files)))throw Error('FINANCIAL_FILES_CHANGED');
    await fs.writeFile(path.join(destination,'settings/restore-proof.json'),JSON.stringify({restoredAt:new Date().toISOString(),verified:true,source:metadata.createdAt,files:observed.files.length,databases:observed.databases.length,financialFilesUnchanged:true,model:relocated.model},null,2)+'\n',{mode:0o600});
    await permissions(path.join(destination,'settings/restore-proof.json'));
    console.log(JSON.stringify({restored:true,verified:true,financialFilesUnchanged:true,model:relocated.model,botStarted:false}));
  }finally{bytes?.fill(0);}
}
async function main(){
  const [command,...args]=process.argv.slice(2);
  if(command==='backup')return backup('/source','/output');
  if(command==='restore'||command==='verify')return restore('/input','/input-key/key','/dest',args[0]??'https://localhost:3443',{verifyOnly:command==='verify'});
  if(command==='relocate')return relocate('/dest',args[0]??'https://localhost:3443');
  if(command==='models'){
    const c=JSON.parse(await fs.readFile('/settings/config.json','utf8'));console.log(c.ollama?.model??'qwen3:4b-instruct-2507-q4_K_M');return;
  }
  if(command==='configure-new'){
    const file='/dest/settings/config.json',c=JSON.parse(await fs.readFile(file,'utf8'));
    c.secretDir='/settings/secrets';c.ollama.url='http://ollama:11434';
    if(c.actual.bases)for(const p of Object.values(c.actual.bases))p.serverURL='http://actual:5006';else c.actual.serverURL='http://actual:5006';
    validateConfig(c);await fs.writeFile(file,JSON.stringify(c,null,2)+'\n',{mode:0o600});
    await fs.writeFile('/dest/settings/secrets/onboarding-key',randomBytes(32).toString('base64')+'\n',{mode:0o600,flag:'wx'});
    await certificate('/dest/settings',args[0]);await permissions('/dest/settings');return;
  }
  throw Error('COMMAND_INVALID');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error('PORTABLE_FAILED '+(error.code??error.message??'UNKNOWN'));process.exitCode=1;});
export {inventory,relocateConfig,requireEmpty};
