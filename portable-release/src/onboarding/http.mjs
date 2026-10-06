import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RegistrationError } from './store.mjs';
import { DASHBOARD_COOKIE, SESSION_SECONDS, dashboardCookie } from '../dashboard/access.mjs';

const WEB=new URL('../../web/',import.meta.url);
const assets=new Map([['/cadastro',['index.html','text/html; charset=utf-8']],['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);
for(const [url,file,type] of [['/dashboard','dashboard.html','text/html'],['/dashboard.js','dashboard.js','text/javascript'],['/dashboard.css','dashboard.css','text/css']])assets.set(url,[file,type+'; charset=utf-8']);
async function readBody(request) {
  let bytes=0;const chunks=[];
  for await(const chunk of request){bytes+=chunk.length;if(bytes>24576)throw new RegistrationError('BODY_LIMIT','Formulário muito grande.',413);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new RegistrationError('JSON_INVALID','Formulário inválido.');}
}
export function createWebHandler({service,settings,dashboard,now=Date.now}) {
  const rate=new Map();
  return async (req,res)=>{
    const headers={
      'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY',
      'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'permissions-policy':'camera=(), microphone=(), geolocation=()',
    };
    const send=(status,value,type='application/json; charset=utf-8')=>{res.writeHead(status,{...headers,'content-type':type});res.end(type.startsWith('application/json')?JSON.stringify(value):value);};
    try {
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&url.pathname==='/health'){send(200,{ok:true});return;}
      if(req.method==='GET'&&assets.has(url.pathname)) {
        const [filename,type]=assets.get(url.pathname);send(200,await fs.readFile(fileURLToPath(new URL(filename,WEB))),type);return;
      }
      if(dashboard&&req.method==='GET'&&url.pathname==='/api/dashboard'){
        if([...url.searchParams.keys()].some(k=>!['month','mode'].includes(k)))throw new RegistrationError('DASHBOARD_PERIOD','Filtro não reconhecido.');
        send(200,await dashboard.data(dashboardCookie(req),Object.fromEntries(url.searchParams)));return;
      }
      if(req.method!=='POST'||!['/api/session','/api/register',...(dashboard?['/api/dashboard/login','/api/dashboard/logout']:[])].includes(url.pathname)){send(404,{error:'NOT_FOUND',message:'Página não encontrada.'});return;}
      if(req.headers.origin!==settings.publicUrl){send(403,{error:'ORIGIN_INVALID',message:'Abra o link enviado pelo Telegram.'});return;}
      if(!String(req.headers['content-type']??'').startsWith('application/json'))throw new RegistrationError('CONTENT_TYPE','Envie o formulário pela página.',415);
      const ip=req.socket.remoteAddress??'unknown',current=rate.get(ip);
      const entry=current&&now()-current.start<60000?current:{start:now(),count:0};entry.count++;rate.set(ip,entry);
      if(entry.count>30)throw new RegistrationError('RATE_LIMIT','Muitas tentativas. Aguarde um minuto.',429);
      if(rate.size>1000)for(const [key,value]of rate)if(now()-value.start>60000)rate.delete(key);
      const body=await readBody(req);
      if(!body||typeof body!=='object'||Array.isArray(body))throw new RegistrationError('FORM_INVALID','Formulário inválido.');
      if(url.pathname==='/api/dashboard/login'){
        const token=dashboard.login(body.token);
        headers['set-cookie']=`${DASHBOARD_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
        send(200,{ok:true});return;
      }
      if(url.pathname==='/api/dashboard/logout'){
        dashboard.access.revoke(dashboardCookie(req));
        headers['set-cookie']=`${DASHBOARD_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
        send(200,{ok:true});return;
      }
      if(url.pathname==='/api/session'){send(200,service.defaults(body.token));return;}
      const result=await service.register(body.token,body.code,body.form);send(200,result);
    }catch(error){
      if(!res.headersSent)send(error instanceof RegistrationError?error.status:500,{error:error instanceof RegistrationError?error.code:'INTERNAL_ERROR',message:error instanceof RegistrationError?error.message:'Não consegui processar o formulário. Tente novamente.'});
      else res.end();
    }
  };
}
export async function startWebServer(options) {
  const {settings}=options,handler=createWebHandler(options);
  const server=settings.publicUrl.startsWith('https:')?https.createServer({cert:await fs.readFile(settings.certFile),key:await fs.readFile(settings.tlsKeyFile)},handler):http.createServer(handler);
  server.requestTimeout=180000;server.headersTimeout=15000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(settings.port,settings.host,resolve);});
  return server;
}
