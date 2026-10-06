import test from 'node:test';
import assert from 'node:assert/strict';
import { categoryCandidates, categoryReply } from '../src/conversation/category-language.mjs';
import { transactionCard } from '../src/reports/transaction-card.mjs';
import { transactionSearchIntent } from '../src/conversation/search-intent.mjs';
const groups = [{ id:'food',name:'Alimentação',hidden:false }];
const categories = ['Restaurantes, padarias e lanches','Delivery e refeições prontas','Consumo','Bebidas e tabacaria'].map((name,i)=>({id:`c${i}`,name,groupId:'food',hidden:false}));

test('everyday descriptions rank only real visible categories, preserving explicit Consumo semantics',()=>{
  assert.equal(categoryCandidates('lanche',categories,groups)[0].id,'c0');
  assert.equal(categoryCandidates('delivery',categories,groups)[0].id,'c1');
  assert.equal(categoryCandidates('remédio',categories,groups).length,0);
  assert.deepEqual(categoryCandidates('cerveja',categories,groups).map(c=>c.id),['c3']);
  assert.deepEqual(categoryCandidates('Consumo',categories,groups).map(c=>c.id),['c2']);
  assert.equal(categoryCandidates('lanche',categories.map(c=>({...c,hidden:true})),groups).length,0);
  assert.equal(categoryCandidates('lanche',categories,groups.map(g=>({...g,hidden:true}))).length,0);
});
test('spoken classification parses explicit numbered targets, refuses negation and mixed purposes',()=>{
  assert.deepEqual(categoryReply('O 2 foi lanche.'),{references:[2],description:'lanche'});
  assert.deepEqual(categoryReply('1 e 3 foram delivery'),{references:[1,3],description:'delivery'});
  assert.deepEqual(categoryReply('foi um remédio'),{references:[],description:'remedio'});
  for(const text of ['não foi lanche','lanche ou remédio','qual foi o lanche?','reembolso do lanche','lembre que foi lanche']) assert.equal(categoryReply(text),null);
});
test('recognition card keeps bank notes when payee is absent or only a CPF, without IDs',()=>{
  const card=transactionCard({id:'PRIVATE_ID',date:'2026-09-22',amount:-1142,notes:'Carrefour Bela Cintra',account:'Cartão Croma'});
  assert.match(card,/Carrefour Bela Cintra/);assert.match(card,/22\/09\/2026/);assert.match(card,/11,42/);assert.doesNotMatch(card,/PRIVATE_ID|não informado/);
  const pix=transactionCard({date:'2026-09-22',amount:-1700,payee:'000.000.000-00',notes:'Transferência enviada|Pessoa de teste',account:'Banco'});
  assert.match(pix,/Pessoa de teste/);assert.match(pix,/000.000.000-00/);
});
test('natural uncategorized listing is a fresh bounded query, never an old empty selection',()=>{
  const intent=transactionSearchIntent('Liste os itens sem categoria, linha a linha','2026-09-23');
  assert.equal(intent.args.uncategorized,true);assert.equal(intent.args.pageSize,10);assert.equal(intent.args.end,'2026-09-23');
  assert.equal(transactionSearchIntent('liste os itens sem categoria e altere tudo','2026-09-23'),null);
});

test('reported latest-ten requests accept counts, everyday nouns and polite wording without losing filters',()=>{
  for(const phrase of [
    'Liste os últimos 10 itens sem categoria por favor',
    'Liste os 10 lançamentos sem categoria',
    'Por favor, mostre os dez últimos lançamentos sem categoria.',
    'Pode me mostrar as últimas 10 transações sem categoria?',
    'Me dê os 10 itens mais recentes sem categoria',
    'Mostre os últimos 10 itens sem categoria, linha a linha, por favor'
  ]){
    const intent=transactionSearchIntent(phrase,'2026-09-23');
    assert.ok(intent,phrase);assert.equal(intent.args.uncategorized,true,phrase);assert.equal(intent.args.pageSize,10,phrase);
    assert.equal(intent.args.end,'2026-09-23');
  }
  const generic=transactionSearchIntent('Mostre os 10 últimos itens','2026-09-23');
  assert.equal(generic.args.pageSize,10);assert.equal(generic.args.uncategorized,undefined);
  const five=transactionSearchIntent('Liste os últimos 5 itens sem categoria da semana passada por favor','2026-09-23');
  assert.equal(five.args.pageSize,5);assert.equal(five.args.start,'2026-09-14');assert.equal(five.args.end,'2026-09-20');
  for(const phrase of ['Liste os 10 itens sem categoria da conta Nubank','Liste os últimos 10 itens acima de 200 reais','Liste os 10 itens sem categoria e exclua todos','Liste os últimos 0 itens','Liste os 10 maiores gastos']) assert.equal(transactionSearchIntent(phrase,'2026-09-23'),null,phrase);
});
