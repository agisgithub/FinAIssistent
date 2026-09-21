# Companheiro financeiro

Esta fase mantém contexto financeiro declarado pelo responsável para conversas do dia a dia. Ela não varre novos lançamentos, não categoriza automaticamente, não troca de base e não cria instâncias Docker.

## Memórias

Há três tipos fechados:

- `planned_purchase`: compra futura declarada, com valor/data opcionais;
- `classification_hint`: texto de favorecedor e nome de categoria informados pelo responsável;
- `financial_note`: fato ou instrução financeira concreta.

Toda memória recebe validade. Sem data explícita, vale por `companion.memoryDefaultTtlDays`, contados da compra planejada ou da data atual. `/memorias` lista somente as ativas. `/esquecer ID` cancela e remove a memória do contexto; o registro local cancelado e o recibo idempotente permanecem para auditoria.

## Metas

As métricas aceitas são:

- `manual_savings_progress`: alvo e progresso informados em centavos;
- `category_spending_cap`: teto mensal em centavos para uma categoria nomeada;
- `account_balance`: saldo-alvo em centavos para uma conta nomeada.

Os estados são `active`, `paused`, `completed` e `cancelled`. A IA cria e atualiza pelo título, sem receber IDs internos. `/metas` mostra IDs ao responsável; `/meta pausar|retomar|concluir|cancelar ID` controla o ciclo de vida deterministicamente.

## Ferramentas e limites

`record_financial_memory`, `manage_financial_goal` e `get_companion_context` aceitam JSON fechado. Elas não aceitam SQL, nomes de métodos do SDK Actual nem IDs financeiros arbitrários. As duas ferramentas de mutação somente validam os campos e criam uma proposta persistente; nenhuma memória ou meta é alterada nessa etapa.

A proposta mostra exatamente o efeito tipado, vence em 15 minutos e pertence à residência, base, responsável, chat e job que a originaram. Somente o botão **Confirmar** ou `/confirmar_companion CODIGO` aplica o efeito. O botão **Cancelar** ou `/cancelar_companion CODIGO` descarta a proposta. Confirmação, gravação local, conclusão do job e criação da resposta Telegram são uma única transação: falha ao enfileirar a resposta desfaz o efeito e mantém a proposta utilizável. Confirmação, cancelamento e reprocessamento são idempotentes; um código consumido não pode ser usado por outro job. Forma hipotética, brincadeira ou interpretação incorreta do modelo, portanto, permanece apenas como proposta visível até a decisão humana.

Os campos continuam fechados: tipo, título/assunto, centavos, datas e nomes de categoria/conta são validados novamente na confirmação. Conteúdo de perfil, traço ou diagnóstico psicológico é recusado como defesa adicional. Comandos determinísticos que já carregam um ID exibido ao responsável (`/esquecer ID` e `/meta ... ID`) continuam diretos.

O contexto automático contém apenas memórias ativas e metas vigentes da combinação residência, orçamento, usuário e chat configurados. `maxContextMemories`, `maxContextGoals` e `maxContextChars` limitam o conteúdo entregue ao modelo. Campos persistidos são declarações financeiras; o sistema não cria perfil psicológico inferido. A orientação deve ser curta, vinculada às metas declaradas e livre de vergonha, culpa, pressão ou coerção.

O texto e os botões completos continuam na resposta Telegram e no recibo de replay. O histórico reutilizado pela IA ou enviado ao Gemini remove códigos de proposta, comandos de confirmação e IDs internos de memória/meta. Quando a mensagem humana pede uma mutação de memória/meta e nenhuma ferramenta companion produz proposta autoritativa, a resposta inteira é determinística: informa que nada foi gravado e pede reformulação. A decisão não depende das palavras usadas pelo modelo em sua resposta; conversas sem intenção de mutação continuam normalmente.

Configuração padrão:

```json
"companion": {
  "enabled": true,
  "transactionMonitorEnabled": false,
  "autoCategorizeHighConfidence": false,
  "memoryDefaultTtlDays": 180,
  "maxContextMemories": 12,
  "maxContextGoals": 8,
  "maxContextChars": 4000
}
```

## Exemplos no Telegram

```text
Vou comprar uma geladeira em 2026-10-10 por R$ 3.200.
Classifique Mercado Bairro como Alimentação.
Minha meta é guardar R$ 5.000 para a reserva da casa até dezembro.
Guardei mais R$ 250 para a meta Reserva da casa.
/confirmar_companion CODIGO_DA_PROPOSTA
/cancelar_companion CODIGO_DA_PROPOSTA
/memorias
/metas
```

Valores financeiros persistidos usam centavos inteiros. Datas usam `YYYY-MM-DD`. Nomes do Actual são referências humanas. O monitor de transações pode usar uma `classification_hint` apenas para enriquecer a pergunta ao responsável; a memória nunca participa do escore, nunca resolve um destino ambíguo e nunca autoriza categorização automática.

O monitor e sua escrita automática começam desligados. Ao ativar somente `transactionMonitorEnabled`, a primeira leitura completa vira baseline silencioso e leituras posteriores perguntam sobre novas despesas elegíveis. `autoCategorizeHighConfidence` exige também escrita real e backup configurado; aplica somente recomendação única, sem conflito, com escore mínimo `0.95`, vinda de regra local ou de confirmações anteriores. Histórico bruto e memória nunca bastam para escrita automática.
