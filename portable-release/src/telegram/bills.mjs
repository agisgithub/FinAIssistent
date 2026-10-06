import { AppError } from '../errors.mjs';
import { label } from '../reports/render.mjs';
import { formatMoney } from '../finance/money.mjs';
export function parseBillCommand(text){
  const input=text.trim();let cursor=0;const tokens=[];
  // One closed grammar: positional words or key=value; quoted values use JSON
  // string escaping. Duplicate/unknown keys are rejected by the command layer.
  while(cursor<input.length){
    while(/\s/.test(input[cursor]??'')&&cursor<input.length)cursor++;
    if(cursor>=input.length)break;
    const rest=input.slice(cursor),match=/^(?:([a-z_]+)=)?("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[^\s"]+)/.exec(rest);
    if(!match)throw new AppError('INPUT_INVALID');
    const value=match[2].startsWith('"')?JSON.parse(match[2]):match[2];tokens.push({key:match[1]??null,value});cursor+=match[0].length;
    if(cursor<input.length&&!/\s/.test(input[cursor]))throw new AppError('INPUT_INVALID');
  }
  const words=[],fields={};let named=false;
  for(const token of tokens){if(token.key){named=true;if(token.key==='__proto__'||Object.hasOwn(fields,token.key))throw new AppError('INPUT_INVALID');fields[token.key]=token.value;}else{if(named)throw new AppError('INPUT_INVALID');words.push(token.value);}}
  return {words,fields};
}
export const SCHEDULE_ADAPTATION='Agenda Actual é fonte observada. O cadastro local é mensal, conforme dia, mês de deslocamento, início e fim confirmados. Regra semanal/anual, endN e ajuste de fim de semana não são copiados nem expandidos automaticamente.';
export const amountText=value=>value==null?'não informado':formatMoney(value);
export function billDetails(b,unitName){return `${label(b.name)} — ID ${b.id}\nUnidade ${label(unitName??b.unitId)} (${b.unitId}); favorecido ${b.payeeId}; conta ${b.accountId}.\nCompetência inicial ${b.startCompetence}; final ${b.endCompetence??'sem fim'}. Vencimento: dia ${b.dueDay}, mês da competência +${b.monthOffset}; ${b.dateKind==='confirmed'?'confirmado pelo responsável':'estimado; vencimento não informado'}. Mês curto: último dia, sem ajuste de dia útil.\nReferência confirmada: ${amountText(b.referenceAmountCents)}. ${b.active?'Cadastro ativo':'Cadastro pausado'}. Fonte: ${b.source}${b.sourceScheduleId?`; agendamento Actual ${b.sourceScheduleId}`:''}.\nLembretes ${b.policy.remindersEnabled?'ativados':'desativados'}, dias antes: ${b.policy.days.join('/')}, ${b.policy.time} (${label(b.policy.timezone)}); alerta de atraso somente com data confirmada.\nVariação ${b.policy.variationEnabled?'ativada':'desativada'}: diferença absoluta estritamente maior que ${amountText(b.policy.variationMinimumCents)} E ${b.policy.variationPercent}% da referência.\n${b.source==='actual'?SCHEDULE_ADAPTATION+'\n':''}Mapeamento futuro: unidade única do par favorecido/conta ou vínculo de agendamento exato; múltiplas unidades exigem resolução explícita. Nenhum lançamento comprova pagamento.`;}
export function renderBillProposal(p){
  if(!p.input)return {text:'Detalhes da proposta removidos pela retenção. Prepare uma nova proposta.'};
  if(p.state!=='pending')return {text:`Proposta local ${p.id}: ${p.state}. Não será aplicada novamente.`};
  return {text:`ALTERAÇÃO LOCAL — persiste mesmo em dryRun. Nenhum dado será escrito no Actual; pagamento é somente registro manual.\n${p.input.preview}\nVálida até ${new Date(p.expires_at).toISOString()} (15 minutos).\n/recorrencia confirmar ${p.nonce}\n/recorrencia cancelar_proposta ${p.nonce}`,replyMarkup:{inline_keyboard:[[{text:'Confirmar alteração local',callback_data:`rf:${p.nonce}`},{text:'Cancelar proposta',callback_data:`rx:${p.nonce}`}]]}};
}
export const BILL_HELP=`/unidades; /unidade cadastrar nome="Apartamento"\n/recorrencias; /recorrencias candidatos; /recorrencias pendencias; /recorrencias atualizar\n/recorrencias favorecidos; /recorrencias agendamentos\n/recorrencia atribuir unidade=ID lancamentos=TX1,TX2\n/recorrencia cadastrar nome="Luz" unidade=ID favorecido=ID conta=ID inicio=2026-09 dia=10 mes_offset=1 tipo_data=confirmado valor_centavos=10000\n/recorrencia editar ID a_partir=2026-10 dia=15\n/recorrencia editar ID a_partir=2026-10 lembretes=sim dias=7,3,1 horario=08:00 variacao=sim percentual=20 minimo_centavos=2000\n/recorrencia rejeitar CANDIDATO; /recorrencia pausar ID\n/proximos_vencimentos [YYYY-MM]; /ocorrencia ID\n/ocorrencia editar ID vencimento=YYYY-MM-DD tipo_data=confirmado valor_centavos=10000\n/pago ID [data=YYYY-MM-DD]; /reabrir ID; /cancelar_ocorrencia ID\nTodos os efeitos locais exigem confirmação de proposta. Valores em centavos; desconhecido para referência ausente; tipo_data estimado quando vencimento não é conhecido. Dias de aviso configuráveis 0–90; lembretes e variação desligados por padrão. /recorrencia confirmar CÓDIGO; /recorrencia cancelar_proposta CÓDIGO.`;
