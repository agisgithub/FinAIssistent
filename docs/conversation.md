# Conversa com ferramentas e escolha de IA

O padrão da conversa é Ollama local. Gemini é uma opção explícita por sessão ou pergunta; indisponibilidade nunca provoca troca automática de provedor. Consultas, relatórios, calendário e confirmações determinísticas continuam acessíveis sem modelo. A IA consulta ferramentas fechadas para obter fatos e preparar propostas; confirmação e execução pertencem à aplicação.

## Buscas simples e períodos

Pedidos claros como `Me dê os lançamentos da semana passada inteira`, `Quais foram meus últimos lançamentos?` e `Procure por Brastemp* nos meus lançamentos` consultam a ferramenta diretamente, sem depender de uma geração da IA para calcular datas ou descrever o resultado. A lista continua no contexto e pode ser referenciada por número na conversa seguinte. Condições extras e pedidos compostos permanecem no fluxo de IA; o atalho não descarta filtros que não reconhece.

- Semana passada: segunda-feira a domingo da semana anterior, calculada com a data local do orçamento. Em 15/09/2026, corresponde a 07/09/2026–13/09/2026.
- Últimos lançamentos sem período: busca nos últimos 12 meses-calendário até hoje, ordenada por data decrescente, até dez itens por página. Não inclui datas futuras nem promete cobrir todo o histórico.
- Busca por nome/observação sem período: últimos 12 meses-calendário, incluindo o mês atual, e os 12 meses seguintes; a resposta informa o intervalo e inclui registros futuros já existentes. Por exemplo, em setembro de 2026, consulta outubro de 2025 a setembro de 2027.
- Período explícito substitui essa janela: por exemplo, `Procure Brastemp nos últimos 3 meses`, `Me liste os lançamentos de 2026-09-01 a 2026-09-14` ou `Procure Brastemp nos próximos 3 meses`. Nomes compostos podem ser escritos entre aspas.

Zero resultados se refere somente ao período, filtros e escopo consultados. Uma falha de leitura não é uma lista vazia. O resultado vazio de uma busca feita pela IA também recebe uma resposta delimitada, em vez de uma conclusão gerada sobre períodos que não foram pesquisados.

## Configurar somente a IA

Depois de configurar Actual e Telegram, execute no servidor Linux:

```bash
bash scripts/configure-ai.sh
```

Para execução direta com Node.js 24, pare o processo e execute `npm run setup:ai` na pasta do projeto. O formulário usa `config.json` existente, preserva Actual, Telegram, `backup`, `dryRun`, diretórios financeiros e `compose.override.yaml`. O helper Docker para somente o bot, usa rede host Linux para consultar Ollama em `127.0.0.1` e permite recriar o bot ao final; não muda a rede permanente do serviço. Com rede bridge, confira se a URL escolhida também é alcançável pelo bot (por exemplo, `host.docker.internal`). Diretórios de segredos personalizados exigem edição manual; não são movidos automaticamente.

O formulário consulta apenas metadados de modelo. Para Ollama, lista modelos locais com capacidade `tools`, pergunta o ID e propõe até 32768 tokens, limitado à capacidade informada. Se a consulta falhar, o nome pode ser configurado com verificação explicitamente pendente; cada geração repetirá a verificação antes de enviar a pergunta. Configure `OLLAMA_NO_CLOUD=1` e reinicie o servidor. Inventário local não comprova isolamento contra um servidor comprometido. [Ollama local e limites](routing.md).

Gemini começa desativado. O formulário pede a chave com entrada oculta e grava um arquivo privado, normalmente `secrets/gemini-api-key`. No JSON fica somente `gemini.apiKeyRef`. Essa referência não pode reutilizar token Telegram, senha Actual, senha de criptografia ou chave de backup. A chave fica fora de argumentos CLI, URL, logs e Telegram. O formulário tenta listar modelos usando a chave em memória; falha é declarada como verificação pendente. A consulta não envia conversa nem dados financeiros.

O modelo inicial configurável é `gemini-3.8-flash`, listado oficialmente como **“Stable”** na documentação consultada em 15/09/2026. A disponibilidade e as cotas do projeto são conferidas em tempo de uso; nenhum crédito ou preço é presumido. [Modelo oficial](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).

Crie uma chave de autorização atual no [Google AI Studio](https://aistudio.google.com/api-keys). A documentação atual distingue essas chaves das antigas chaves padrão e anuncia restrições às antigas em setembro de 2026; use o fluxo vigente da conta. O transporte usa `x-goog-api-key`, exclusivamente entre servidor e Google. [Chaves da API](https://ai.google.dev/gemini-api/docs/api-key).

## Comandos e consentimento

| Comando | Efeito |
| --- | --- |
| `/ia` | Mostra seleção de provedor e comandos |
| `/ia ollama` | Seleciona o provedor local |
| `/ia gemini` | Prepara aviso de exportação de contexto, com confirmação própria |
| `/ia modelos` ou `/ia listamodelos` | Consulta modelos do provedor atual; Ollama inclui somente locais compatíveis com ferramentas/contexto |
| `/ia modelo ID` | Seleciona um ID disponível no inventário do provedor atual |
| `/ia limpar` | Apaga histórico, seleção numerada e consentimentos; conserva o provedor escolhido |
| `/gemini pergunta` | Solicita envio remoto único, com confirmação própria; não troca o provedor da sessão |
| `/lote` ou `/lote ID` | Lista ou detalha operações propostas pela conversa |
| `/confirmar_lote CÓDIGO` ou botão | Confirma a proposta financeira exibida; não aceita confirmação escrita pelo modelo |
| `/cancelar_lote CÓDIGO` ou botão | Cancela uma proposta financeira pendente |

O aviso Gemini informa que pergunta, histórico limitado, memórias/metas financeiras ativas e resultados financeiros limitados das ferramentas podem ser enviados ao Google, incluindo nomes, notas, datas e valores. O snapshot completo e os arquivos de segredos não são fornecidos como contexto. O nonce dura 15 minutos, é vinculado ao responsável/chat/orçamento e à versão do contexto; mudança no contexto exige nova revisão. Esperar, expirar ou pedir uma proposta financeira não equivale a consentir com envio remoto.

O texto corrente também pode conter dados sensíveis. Não digite senhas ou chaves na conversa. Redação de padrões conhecidos é uma defesa limitada, sem detecção universal. Resumos e pseudônimos não tornam dados financeiros automaticamente anônimos.

### Tratamento de dados Gemini

Os termos da API diferenciam uso **sem faturamento ativo** e uso **com Cloud Billing ativo no projeto da API**. Na oferta sem faturamento, entradas e saídas podem ser usadas para melhorar produtos/modelos e passar por revisão humana; os termos orientam não fornecer dados pessoais, sensíveis ou confidenciais. As exceções regionais citadas para EEE/Suíça/Reino Unido não são uma garantia geral para o Brasil. No projeto com faturamento ativo, prompts/respostas não são usados para melhorar produtos, mas processamento e registros limitados de segurança, abuso e obrigações legais permanecem possíveis. Uma assinatura pessoal do Google não comprova a condição do projeto da API. Os termos também dizem **“not for consumer use”**; o operador deve conferir a elegibilidade do uso pretendido. Habilitar a configuração não altera esses termos. [Termos oficiais](https://ai.google.dev/gemini-api/terms).

O aplicativo não declara retenção zero, custo zero nem conformidade jurídica automática. O padrão local permanece disponível. Cotas são por projeto/modelo/tier; consulte o AI Studio. Contadores ausentes são desconhecidos, não zero. [Limites de uso](https://ai.google.dev/gemini-api/docs/rate-limits).

## Arquitetura e protocolo

`ConversationService` mantém a sessão limitada e coordena `FinanceTools` com `ChatProviders`. O provedor somente retorna texto e pedidos de ferramentas; não resolve dados financeiros nem executa SDK. As ferramentas financeiras são `search_transactions`, `list_categories`, `query_finances`, `monthly_spending_series` e `prepare_category_changes`; o companheiro acrescenta `record_financial_memory`, `manage_financial_goal` e `get_companion_context`. Seus argumentos são validados localmente, os IDs financeiros vêm do catálogo e a camada financeira calcula centavos e totais. As duas ferramentas mutáveis do companheiro terminam o turno com uma proposta autoritativa e botões; somente a confirmação posterior no Telegram grava. A IA trabalha por título e campos fechados, sem receber IDs internos de memória/meta. Por exemplo, 3000 centavos significam R$ 30,00; um modelo não escolhe outra unidade monetária nem substitui cálculos de código. [Memórias e metas](companion.md).

`monthly_spending_series` recebe somente nome da categoria, quantidade de meses (1–24) e tipo `bar`/`line`. O executor resolve homônimos pelo nome do grupo e consulta todo o período em uma única AQL de transações com `splits:inline`; IDs e AQL não entram no contrato do modelo. A resposta contém PNG local com título, categoria, meses, escala, valores, total e média, além da mesma série em texto acessível. O texto conversacional é limitado e orientado a mostrar a conclusão primeiro. O pedido “gráfico de gastos dos últimos 6 meses para Consumo” tem interpretação determinística antes do modelo.

`complete({provider,model?,messages,tools})` retorna `{text,toolCalls,assistantMessage,usage,provider,model,durationMs}`. Cada chamada contém `{id,name,args}`. Mensagens usam `system`, `user`, `assistant` e `tool`; resultados de ferramentas são JSON objeto com `toolCallId` e `name`. `listModels({provider})` retorna IDs e limites conhecidos. As URLs dos provedores nunca são obtidas da resposta do modelo.

- **Ollama:** `GET /api/tags`, `POST /api/show` e `POST /api/chat`, com `stream:false`. São exigidos GGUF local, digest/tamanho, contexto e capacidades `completion` + `tools`. O histórico da rodada conserva a mensagem nativa, incluindo `thinking` quando necessário, mas esse campo não aparece na resposta do usuário. Resultados usam `role:tool` e `tool_name`. [Chat](https://docs.ollama.com/api/chat), [ferramentas](https://docs.ollama.com/capabilities/tool-calling).
- **Gemini:** HTTP nativo `POST https://generativelanguage.googleapis.com/v1beta/models/{ID}:generateContent`, com `functionDeclarations.parametersJsonSchema`, `functionCallingConfig.mode:AUTO` e saída limitada. `generateContent` continua suportado; este adaptador não usa nem mistura o estado da API Interactions. O catálogo é `GET /v1beta/models`, filtrado por `generateContent`. [REST e schemas](https://ai.google.dev/api/generate-content), [modelos](https://ai.google.dev/api/models), [estado da API](https://ai.google.dev/gemini-api/docs/interactions-overview).
- **Continuação Gemini:** conserva o `candidate.content` inteiro na rodada, inclusive `thoughtSignature` no mesmo `part`; `thought:true` nunca entra em `text`. Chamadas paralelas são seguidas por uma mensagem `user` com todos os `functionResponse`, nomes e IDs devolvidos pelo serviço. Se não houver ID nativo, a aplicação usa correlação interna sem inventar um ID no protocolo. Trocar provedor/modelo remove esses quadros nativos; somente contexto textual revisado é exportado. [Function calling](https://ai.google.dev/gemini-api/docs/generate-content/function-calling), [assinaturas](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures).

`assistantMessage.providerContent` é transitório durante a rodada. O banco de conversa guarda texto final e seleção limitada; não guarda pensamentos nem assinaturas nativas. O histórico padrão dura até 24h, no máximo 12 turnos e sujeito ao teto de bytes; doze turnos completos não são garantidos. `/ia limpar` remove o contexto usado nas próximas conversas e as seleções; não apaga mensagens já entregues no Telegram, jobs, operações, outbox ou backups com retenção própria. Dados já processados pelo Gemini continuam sujeitos às políticas do provedor.

## Limites de contexto e falhas

| Configuração | Padrão | Faixa |
| --- | --- | --- |
| `assistant.historyTtlMinutes` | 1440 | 1–1440 |
| `assistant.maxTurns` | 12 | 1–24 |
| `assistant.maxToolRounds` | 4 | 1–8 |
| `assistant.maxToolCalls` | 8 | 1–16 |
| `assistant.maxContextChars` | 24000 | 1024–100000 |
| `assistant.maxToolResultChars` | 8000 | 256–16000 |
| `assistant.maxRequestBytes` | 131072 | 4096–1048576 |
| `assistant.outputTokens` (Ollama conversa) | 1024 | 64–4096 |
| `gemini.timeoutMs` | 60000 | 1000–120000 |
| `gemini.maxResponseBytes` | 262144 | 1024–1048576 |
| `gemini.outputTokens` | 4096 | 64–8192 |

Os limites da sessão não garantem que um modelo comporte todo o contexto. O adaptador mede o JSON completo, incluindo instruções, schemas, resultados e assinaturas. No Ollama, bytes de entrada + reserva de saída + 512 devem caber em `contextTokens`; é uma estimativa conservadora, não o tokenizer do modelo. Configurações antigas mantêm padrão de 8192 tokens; o configurador propõe até 32768 se suportado e os novos exemplos usam 32768, com Ollama ainda desligado. Modelos menores podem exigir consultas mais específicas. Não há truncamento silencioso de pergunta, filtro ou instruções no provedor; excesso produz `CHAT_CONTEXT_LIMIT`. Resultados paginados/limitados precisam continuar identificados como incompletos.

Um único prazo inclui descoberta, geração e leitura de corpo. Respostas enormes, incompletas, ferramentas desconhecidas, argumentos não JSON e conteúdo multimodal inesperado são recusados. Erros refletem somente códigos permitidos, sem corpo remoto, chave ou URL de autenticação. Não há repetição automática de geração; timeout pode ter consumido cota mesmo sem resposta. `usage` informa apenas contadores observados (entrada, saída, total, cache e pensamentos quando disponíveis), sem estimar dinheiro.

Para o ID conhecido `gemini-3.8-flash`, o request usa `thinkingLevel:low`; esse modelo não aceita `minimal`. Outros IDs não recebem essa opção automaticamente (a série 2.5 usa outro contrato). A reserva de 4096 inclui pensamentos e saída; ainda pode ser insuficiente em uma tarefa complexa. `MAX_TOKENS` é recusado sem executar ferramenta parcial. [Thinking e teto de saída](https://ai.google.dev/gemini-api/docs/generate-content/thinking). Confira preços e tratamento por oferta na [tabela oficial](https://ai.google.dev/gemini-api/docs/pricing), sem presumir cota gratuita.

## Propostas e critérios de aceite

Uma conversa pode preparar uma categoria nova em grupo real, ou até dez mudanças de categoria em lançamentos já lidos. A proposta mostra os alvos e exige confirmação fora do modelo. Uma categoria criada e itens já aplicados podem permanecer quando uma operação posterior falha: **o lote não é uma transação atômica no Actual**. Itens incertos não são repetidos; consulte `/lote ID` e confira o Actual antes de preparar outra proposta. `dryRun` continua simulando escrita no Actual. As regras locais de recorrências continuam independentes desse modo. [Autorização](authorization.md).

O aceite exige: configurações antigas funcionarem; nenhuma exportação remota antes de consentimento; IDs e seleções limitados e revalidados; replay não repetir propostas/escritas; 8 parcelas com catálogo real caberem no contexto configurado; signatures/IDs de chamadas paralelas preservados; troca de provedor não exportar estado nativo; timeout/429/erros não acionarem fallback remoto; configuração IA preservar segredos e parâmetros não relacionados. `test/chat-providers.test.mjs` usa HTTP simulado; `test/setup-ai.test.mjs` prova preservação/cancelamento/rollback. Testes do serviço e ferramentas cobrem a coordenação. Esses testes e o SDK sintético não comprovam qualidade, latência, disponibilidade ou funcionamento de um modelo real no servidor do operador.
