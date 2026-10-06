const token=location.hash.slice(1);
history.replaceState(null,'',location.pathname);
const form=document.querySelector('#registration'),notice=document.querySelector('#notice'),button=document.querySelector('#submit');
const error=message=>{notice.textContent=message;notice.className='error';notice.scrollIntoView({behavior:'smooth',block:'center'});};
const api=async(path,body)=>{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store',credentials:'omit'});const data=await response.json();if(!response.ok)throw Error(data.message??'Falha na conexão.');return data;};
function providerFields(){document.querySelector('#cloudFields').hidden=form.elements.provider.value!=='gemini';}
form.elements.provider.addEventListener('change',providerFields);
async function initialize(){
  if(!token){error('Abra o link individual enviado pelo bot no Telegram. Envie /cadastro para receber um novo.');return;}
  try {
    const data=await api('/api/session',{token});
    for(const server of data.servers){const option=document.createElement('option');option.value=server;option.textContent=server;form.elements.serverURL.append(option);}
    for(const name of ['displayName','serverURL','budgetId','timezone','provider','model','reconciliationTime'])form.elements[name].value=data[name]??'';
    form.elements.allowEdits.checked=data.allowEdits;
    form.elements.dailyReconciliation.checked=data.dailyReconciliation;
    form.elements.actualPassword.required=!data.hasPassword;
    if(data.hasPassword)form.elements.actualPassword.placeholder='Em branco para manter a senha atual';
    if(data.hasApiKey)form.elements.apiKey.placeholder='Em branco para manter sua chave atual';
    if(data.hasEncryption)form.elements.encryptionPassword.placeholder='Em branco para manter a senha atual';
    form.elements.provider.querySelector('[value="ollama"]').disabled=!data.localEnabled;
    providerFields();notice.textContent='Link validado. Preencha seus acessos para começar.';form.hidden=false;
  }catch(e){error(e.message);}
}
form.addEventListener('submit',async event=>{
  event.preventDefault();button.disabled=true;button.textContent='Validando os acessos…';notice.className='';notice.textContent='Conectando ao Actual e à IA. Isso pode levar até dois minutos.';
  const fields=Object.fromEntries(new FormData(form));const code=fields.code;delete fields.code;
  fields.allowEdits=form.elements.allowEdits.checked;fields.cloudConsent=form.elements.cloudConsent.checked;
  fields.dailyReconciliation=form.elements.dailyReconciliation.checked;
  try{await api('/api/register',{token,code,form:fields});form.reset();form.hidden=true;notice.textContent='Cadastro concluído.';document.querySelector('#success').hidden=false;}
  catch(e){error(e.message);button.disabled=false;button.textContent='Tentar conectar novamente ↗';}
});
initialize();
