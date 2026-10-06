import { readFile } from 'node:fs/promises';
import { AppError } from '../errors.mjs';
import { FINANCE_TOOL_DEFINITIONS } from '../application/assistant-tools.mjs';
import { periodReport, reportText } from './period-report.mjs';
import { renderPeriodChart } from '../reports/chart.mjs';
import { encodePngPhoto } from '../telegram/media.mjs';

const EXTRA=[
  {name:'period_report',description:'Relatório completo por grupo macro ou categoria, qualquer período de até 24 meses. Entradas, saídas, estornos e gastos líquidos, sem transferências vinculadas e saldos iniciais. Futuro: registros existentes, não previsão.',parameters:{type:'object',additionalProperties:false,required:['start','end'],properties:{start:{type:'string',format:'date'},end:{type:'string',format:'date'},groupBy:{type:'string',enum:['group','category']}}}},
  {name:'render_chart',description:'Gera gráfico PNG a partir do resultRef de period_report, sem consultar de novo nem recalcular totais. Passe inputRef e parameters "{}".',parameters:{type:'object',additionalProperties:false,properties:{}}}
];
export const SKILLS=Object.freeze([...FINANCE_TOOL_DEFINITIONS,...EXTRA]);
export const SKILL_TOOLS=Object.freeze([
  {name:'skill_help',description:'Consulte o manual .md e os parâmetros de uma skill; sem name lista as skills disponíveis. Leia antes de usar uma skill desconhecida.',parameters:{type:'object',additionalProperties:false,properties:{name:{type:'string',enum:SKILLS.map(s=>s.name)}}}},
  {name:'skill',description:'Executa um script financeiro interno. name é a skill, parameters é um objeto JSON serializado com seus parâmetros. Encadeie saídas por inputRef, nunca shell, SQL ou IDs inventados. Escritas preparam proposta e exigem confirmação humana.',parameters:{type:'object',additionalProperties:false,required:['name','parameters'],properties:{name:{type:'string',enum:SKILLS.map(s=>s.name)},parameters:{type:'string',maxLength:12000},inputRef:{type:'string',maxLength:80}}}}
]);
export const SKILL_SYSTEM=`Use skills internas; a pessoa conversa normalmente, sem digitar comandos ou IDs. Catálogo: ${SKILLS.map(s=>s.name).join(', ')}. Para relatório/gráfico macro: skill period_report com start,end,groupBy="group"; depois skill render_chart com inputRef=resultRef do relatório e parameters="{}". Para classificar: search_transactions -> list_categories -> prepare_category_changes. Consulte skill_help para parâmetros e exemplos. Toda resposta sobre valores/dados precisa de leitura nesta rodada. Nunca invente ausência de dados nem impossibilidade de consultar futuro. Datas futuras significam registros existentes. A confirmação de escrita nunca é uma skill executável pela IA.`;
const obj=x=>x&&typeof x==='object'&&!Array.isArray(x);

// One instance per turn: references cannot cross users, budgets, or turns.
export class SkillSession {
  constructor({config,store,actual,now=()=>new Date(),tools}){Object.assign(this,{config,store,actual,now,tools});this.results=new Map();this.count=0;}
  resolve(call) {
    if(call.name!=='skill')return call;
    const args=call.args;
    if(!obj(args)||Object.keys(args).some(k=>!['name','parameters','inputRef'].includes(k))||typeof args.parameters!=='string'||args.parameters.length>12000||!SKILLS.some(s=>s.name===args.name))throw new AppError('INPUT_INVALID');
    let parameters;try{parameters=JSON.parse(args.parameters);}catch{throw new AppError('INPUT_INVALID');}
    if(!obj(parameters)||args.inputRef!==undefined&&typeof args.inputRef!=='string')throw new AppError('INPUT_INVALID');
    let inputRef=args.inputRef;
    if(args.name==='render_chart'){
      // Models may put the reference in the parameter object; normalize only
      // this known field. The value must still resolve inside this session.
      if(parameters.inputRef!==undefined){if(inputRef!==undefined&&inputRef!==parameters.inputRef)throw new AppError('INPUT_INVALID');inputRef=parameters.inputRef;delete parameters.inputRef;}
      if(inputRef===undefined){const reports=[...this.results].filter(([,r])=>r.kind==='period_report');if(reports.length===1)inputRef=reports[0][0];}
      if(typeof inputRef!=='string')throw new AppError('INPUT_INVALID');
    }else if(inputRef!==undefined)throw new AppError('INPUT_INVALID');
    return {...call,name:args.name,args:parameters,inputRef};
  }
  async execute(call,context) {
    this.store.assertIdentity(context.identity);
    if(++this.count>16)throw new AppError('INPUT_INVALID');
    if(call.name==='skill_help') {
      if(!obj(call.args)||Object.keys(call.args).some(k=>k!=='name'))throw new AppError('INPUT_INVALID');
      const entry=SKILLS.find(s=>s.name===call.args.name);
      if(call.args.name!==undefined&&!entry)throw new AppError('INPUT_INVALID');
      return {data:entry?{kind:'skill_manual',...entry,markdown:await readFile(new URL(`../../skills/${entry.name}.md`,import.meta.url),'utf8')}:{kind:'skill_catalog',skills:SKILLS.map(({name,description})=>({name,description}))}};
    }
    let result;
    if(call.name==='period_report')result=await periodReport(call.args,this);
    else if(call.name==='render_chart') {
      if(Object.keys(call.args).length)throw new AppError('INPUT_INVALID');
      const report=this.results.get(call.inputRef);
      if(report?.kind!=='period_report'||report.complete!==true)throw new AppError('INPUT_INVALID');
      result={data:{kind:'period_chart',inputRef:call.inputRef,complete:true,period:report.period},message:{text:reportText(report),photo:encodePngPhoto(renderPeriodChart(report),'gastos-por-grupo.png')}};
    } else {
      if(!SKILLS.some(s=>s.name===call.name))throw new AppError('INPUT_INVALID');
      result=await this.tools.execute(call.name,call.args,context);
    }
    if(!obj(result?.data))throw new AppError('SNAPSHOT_INVALID');
    const resultRef=`result_${this.results.size+1}`;this.results.set(resultRef,structuredClone(result.data));
    const nextSkill=result.data.kind==='period_report'?{name:'render_chart',parameters:'{}',inputRef:resultRef}:null;
    return {...result,data:{...result.data,resultRef,...(nextSkill?{nextSkill}:{}),moneyUnit:'integer cents; divide by 100 for BRL'}};
  }
  chartCall(){const reports=[...this.results].filter(([,r])=>r.kind==='period_report');return reports.length===1?{name:'render_chart',parameters:'{}',inputRef:reports[0][0]}:null;}
}
