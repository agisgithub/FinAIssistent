# Skills internas do FinAIssistent

## Interface humana

Conversa natural. Exemplos: “relatório dos últimos 30 dias”, “gráfico macro deste mês”, “gastos por grupo de novembro de 2026”, “liste os últimos 10 itens sem categoria”, “2 foi lanche”. Ajuda não publica IDs nem a lista de comandos técnicos; aliases antigos continuam disponíveis por compatibilidade administrativa. Implementação: `src/telegram/commands.mjs`, “Converse normalmente, sem comandos ou IDs”.

## Interface da IA

Duas ferramentas: `skill_help` consulta catálogo/manual e schema; `skill` executa script com `name`, `parameters` (JSON serializado), `inputRef` opcional. Implementação: `src/skills/runtime.mjs`, `SKILL_TOOLS`.

```json
{"name":"period_report","parameters":"{\"start\":\"2026-08-26\",\"end\":\"2026-09-24\",\"groupBy\":\"group\"}"}
```

Exemplo ilustrativo de encadeamento, usando a referência realmente devolvida:

```json
{"name":"render_chart","parameters":"{}","inputRef":"result_1"}
```

Uma sessão pertence a um turno e a um vínculo usuário/orçamento. Referências não carregam dados financeiros e não dão acesso a outro vínculo. Gráfico só consome relatório existente, não totais enviados pelo modelo. Omissão da referência só pode ser resolvida quando há exatamente um relatório na sessão.

## Operações cobertas

| Script / manual em skills/ | Função |
|---|---|
| search_transactions.md | Busca por período, texto, categoria, sem categoria e páginas |
| list_categories.md | Catálogo real, grupos e sinônimos cotidianos |
| query_finances.md | Resumo, gastos, orçamento, contas, comparação, maiores gastos e pendências |
| period_report.md | Agregação completa por grupos/categorias, entradas/saídas e conciliação separada |
| render_chart.md | Relatório → gráfico PNG com texto acessível |
| monthly_spending_series.md | Série mensal de uma categoria |
| prepare_category_changes.md | Prévia de classificação/reclassificação de até 10 itens e criação de categoria em grupo existente |
| record_financial_memory.md | Prévia de memória financeira declarada |
| manage_financial_goal.md | Prévia de criação e alteração de metas |
| get_companion_context.md | Leitura de memórias e metas |

Fonte do catálogo executável: `src/skills/runtime.mjs`, `SKILLS`. Os dez manuais explicam objetivo, entrada, passos, saída e limites; o schema devolvido por skill_help é o contrato exato. Os scripts compartilham o executor e reutilizam os serviços existentes, em vez de duplicar cálculos/escritas.

Isso cobre as consultas e as escritas já expostas à IA. **Não dá acesso SQL/shell irrestrito nem implementa todas as operações do SDK do Actual.** Exclusão de contas/lançamentos, edição genérica de valor/data, fusão de transferências e alteração de regras continuam fora deste catálogo. Nunca afirmar que foram executadas.

## Escritas

A cadeia é busca → catálogo → proposta. O usuário confirma pelos botões originais; a IA não possui skill de confirmação. Permanecem validação de identidade, conferência do estado atual, diário, backup e verificação pós-escrita (`src/application/assistant-actions.mjs`: `prepare`; `src/application/actions.mjs`: operações existentes).

O conciliador diário continua na rotina existente; esta mudança não cria outro cron nem reclassifica o histórico.

## Relatórios e política de apresentação

`period_report` consulta todos os registros elegíveis no intervalo; não soma só dez itens da primeira página. Exclui transferências vinculadas, pais de divisões e saldos iniciais. Compras no cartão seguem a data do lançamento, não a data do pagamento da fatura.

Futuro é permitido como **registros existentes**, nunca como pagamentos comprovados ou previsão completa. “A orçar” não é gasto mensal.

A preferência `financial_report_policy` é opcional, versionada e vinculada ao budgetId, com `technicalCategoryIds` definidos por orçamento. A HML2 reutiliza as decisões D15 e de principal de empréstimos: movimentos técnicos aparecem separados do consumo. Categorias apenas ocultas não são automaticamente excluídas. A instalação administrativa preserva a preferência anterior em JSON e não modifica lançamentos.

Fonte: `src/skills/period-report.mjs`, “Separado do gasto pessoal”; decisões históricas em `outputs/documentacao-actual/DECISOES.md`, D15. Para outra pessoa, rever a taxonomia e configurar IDs próprios; não copiar IDs da HML2.

## Terminal

```bash
node scripts/skill.mjs list
node scripts/skill.mjs --base financa-hml2 period_report \
  --start 2026-08-26 --end 2026-09-24 --groupBy group \
  --then render_chart --out /tmp/gastos.png
```

A CLI é administrativa, somente leitura financeira; exportação não sobrescreve arquivo existente. Propostas de escrita usam o contexto autenticado de uma mensagem no bot. Cada execução da CLI usa cache SDK próprio. JSON de dados financeiros não deve ser incluído em pacote público.

## Extensão

Adicionar uma operação exige: serviço de domínio com validação, entrada/saída estruturada, registro em SKILLS, manual .md e testes de identidade, falha, composição e efeitos. Uma nova escrita exige também prévia/confirmador, backup e tratamento de resultado incerto. Nunca adicionar uma skill que execute texto arbitrário como shell/SQL.

## Verificação e publicação

`npm test` cobre regressões e composição sintética. `scripts/check-skills-live.mjs` verifica HML2 sem método de escrita e sem IA por padrão. `scripts/check-skills-provider.mjs` testa o Ollama com dados fictícios, sem acessar Actual. Não usar --model com dados reais sem autorização para o destino.

Rollback do código: imagem Docker anterior preservada na publicação. Rollback da preferência: repor `before` do JSON de backup, apenas no orçamento correspondente. Não apagar volumes.

### Registro da publicação de 24/09/2026

- Imagem publicada: `finaissistent:skills-20260924`; anterior: `finaissistent:before-skills-20260924`. Verificação Docker: `running healthy`; HTTPS `/health`: `{"ok":true}`.
- Suíte isolada: `tests 472`, `pass 472`, `fail 0`. Evidência local: `work/finaissistent-skills-tests.log`.
- Dois cenários adicionados depois também passaram: composição de classificação e normalização de referências; o arquivo de skills teve `tests 9`, `pass 9`, `fail 0`.
- Modelo real local `qwen3:4b-instruct-2507-q4_K_M`: composição com fixtures, `syntheticOnly: true`, `actualAccess: false`, `hasChart: true`. Evidência: `work/finaissistent-skills-provider.log`. Não foi realizado teste enviando dados financeiros reais ao modelo.
- HML2 consultada com `financialWrites: 0`, `modelCalls: 0`: pedidos originais de setembro e novembro e relatório dos últimos 30 dias. Evidência: `work/finaissistent-skills-live-final.json`.
- CLI na imagem publicada retornou `hasChart: true`; menu técnico removido: `menusRemoved: 1`, `commandsRemoved: 1`, aliases administrativos preservados.
- Telegram confirmou `delivered: true`, mensagem `717`, com instruções e gráfico. Isso comprova aceitação da API, não leitura pelo destinatário.

As evidências financeiras são privadas e não entram em um pacote genérico. As contagens acima descrevem esta publicação, não uma garantia de funcionamento futuro de serviços externos.
