import { RegistrationError } from './store.mjs';

export function privateSender(update) {
  if(!Number.isSafeInteger(update?.update_id)||update.update_id<0)return null;
  const message=update.callback_query?.message??update.message;
  const from=update.callback_query?.from??message?.from;
  if(!from||from.is_bot!==false||!Number.isSafeInteger(from.id)||from.id<=0||message?.chat?.type!=='private'||message.chat.id!==from.id)return null;
  if(message.forward_origin||message.forward_from||message.forward_sender_name||message.via_bot)return null;
  return {userId:from.id,chatId:message.chat.id,displayName:String(from.first_name??'').slice(0,80)};
}

export function routeGatewayUpdate(update,{store,settings,getRuntime,dashboard}) {
  const sender=privateSender(update);
  if(!sender){store.advance(update?.update_id);return;}
  const runtime=getRuntime(sender.userId),text=String(update.message?.text??'').trim();
  const command=text.split(/\s+/)[0]?.toLowerCase().split('@')[0];
  const wantsDashboard=command==='/dashboard'||/^(?:(?:abrir|abra|mostrar|mostre|ver|quero|acesse|acessar|me manda|me envie)\s+)?(?:o\s+)?(?:link\s+(?:do|para o)\s+)?(?:dashboard|painel)(?:\s+(?:financeiro|de gastos|de economia))?[.!?]?$/i.test(text);
  if(runtime&&dashboard&&wantsDashboard){
    store.recordUpdate(update.update_id,()=>{
      const link=dashboard.link(sender.userId);
      store.enqueue(update.update_id,sender.chatId,{text:`Seu painel de gastos · ${link.alias}\n\n${settings.publicUrl}/dashboard#${link.token}\n\nLink privado, de uso único, válido por 10 minutos. O navegador mantém acesso por 12 horas. Abra na rede ou VPN do servidor e não compartilhe o link.\n\nAtualiza automaticamente a cada 20 segundos enquanto está aberto. Reflete os lançamentos já sincronizados com o Actual; não antecipa a sincronização bancária. Nenhum lançamento é alterado pelo painel.`,link_preview_options:{is_disabled:true}});
    });
    store.advance(update.update_id);return;
  }
  const registration=['/start','/cadastro','/configurar','/settings'].includes(command)||/^(?:configurar|atualizar acessos|cadastro)$/i.test(text);
  if(registration||!runtime||command==='/piloto') {
    store.recordUpdate(update.update_id,()=>{
      let payload;
      if(command==='/piloto') {
        const available=sender.userId===settings.legacyUserId&&store.now()<settings.pilotUntil;
        const message=text.replace(/^\/piloto(?:@\w+)?\s*/i,'').slice(0,4000);
        if(available&&message){store.db.prepare('INSERT OR IGNORE INTO pilot_messages VALUES(?,?,?,?)').run(update.update_id,sender.userId,message,store.now());payload={text:'Mensagem registrada para o acompanhamento desta implementação. Ela não será tratada como ordem para alterar o Actual. O retorno depende da sessão de trabalho estar ativa.'};}
        else payload={text:available?'Use /piloto seguido da sua mensagem para esta implementação.':'O acompanhamento temporário está encerrado. Converse normalmente com a IA para usar o sistema.'};
      }else if(registration){
        try{
          const invitation=store.createInvite(sender);
          payload={text:`Vamos configurar seu assistente financeiro.\n\nAbra o link, válido por 30 minutos:\n${settings.publicUrl}/cadastro#${invitation.token}\n\nCódigo: ${invitation.code}\n\nUse a mesma rede ou VPN do servidor. O certificado deste piloto é local; confirme o IP antes de aceitar o aviso do navegador. Não envie senhas nem chaves aqui no chat.`};
        }catch(error){if(!(error instanceof RegistrationError))throw error;payload={text:error.message};}
      }else payload={text:'Olá! Para conectar seu orçamento e sua IA, envie /start. Cada cadastro fica vinculado exclusivamente à sua conta do Telegram.'};
      store.enqueue(update.update_id,sender.chatId,payload);
    });
  }else runtime.router.accept(update);
  store.advance(update.update_id);
}
