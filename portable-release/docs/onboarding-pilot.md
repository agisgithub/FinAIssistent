# Cadastro web e IA financeira no Telegram

Piloto implementado em 23/09/2026. Este documento complementa os contratos existentes; registre novas decisões ao final, sem apagar as anteriores.

## O que está publicado

- Projeto no Debian: `/home/agis/FinAIssistent`.
- Host: `10.11.46.109`; bot: `@Jackie_the_bot_bot`.
- Cadastro: `https://10.11.46.109:3443/cadastro`, acessível pela mesma rede/VPN.
- Imagem: `finaissistent:onboarding-20260923`; entrada: `src/onboarding/main.mjs`.
- Actual principal: porta local `5006`; segunda instalação: `5007`. Nenhuma instalação Actual foi substituída.
- A base atualmente selecionada do administrador foi preservada: `financa-hml2`.
- Conciliador habilitado nessa base: todos os dias às **09:00, America/Sao_Paulo**. Primeira ocorrência prevista: 24/09/2026, 09:00.
- A configuração preexistente da base `principal` foi preservada; não habilitamos nela a nova rotina diária.

O endereço sem convite só mostra instruções. O acesso ao formulário vem de um link individual enviado pelo bot. O certificado HTTPS é local/autossinado: o navegador pode mostrar um aviso. Confira o IP e, se decidir prosseguir, aceite o certificado você mesmo. Não abra a porta indiscriminadamente para a Internet.

## Fluxo do usuário

1. Abra [o bot no Telegram](https://t.me/Jackie_the_bot_bot) em conversa privada e envie `/start` ou `/cadastro`.
2. O bot envia um link individual e um código de seis dígitos. Validade: 30 minutos, um uso. Pedir outro link invalida o anterior.
3. Preencha nome, fuso, servidor Actual, Sync ID, senha do servidor, senha de criptografia do orçamento se existir, provedor/modelo e API key se escolher Gemini.
4. Escolha se permite escrita e se quer o conciliador diário, com horário no seu fuso. O formulário explica a autorização para classificações automáticas.
5. O sistema abre o orçamento em cache isolado e valida o acesso ao modelo. Não grava um cadastro com credenciais inválidas.
6. Após salvar, o bot envia boas-vindas e a conversa já usa o provedor escolhido.

O token do **bot Telegram** é único, configurado pelo administrador. Cada usuário não precisa criar outro bot nem fornecer esse token. Novos usuários não herdam a API key do administrador.

Para o administrador, `/base usar financa-hml2` seleciona a homologação antes de abrir `/cadastro`. Seu formulário mantém os dois orçamentos registrados e atualiza as credenciais Actual apenas do perfil selecionado. Provedor de IA e permissão de escrita são configurações do usuário; a rotina diária é gravada na base selecionada. Para novos usuários, o primeiro orçamento recebe o alias `principal`.

## IA com acesso de escrita

A IA consulta dados reais por ferramentas fechadas, não por SQL arbitrário ou comandos de shell. Pode buscar lançamentos, consultar gastos/orçamento/contas, produzir séries e gráficos e ler o contexto explicitamente salvo.

Escritas disponíveis neste piloto:

- Alterar categorias de lançamentos elegíveis, individualmente ou em lotes de até 10.
- Criar categoria em um grupo já existente e usá-la no mesmo lote.
- Registrar/remover memórias e administrar metas locais.
- Aplicar a categorização automática do conciliador, conforme os critérios abaixo.

Exemplos: “Mostre os gastos de ontem”, “Classifique estes dois lançamentos como Mercado”, “Crie a categoria Academia no grupo Saúde”. Pedidos financeiros da conversa exibem prévia e exigem confirmação do usuário. **Permitir escrita** significa gravar de fato após confirmação; quando desmarcado, propostas são simuladas, sem gravação no Actual.

Isso não é acesso irrestrito: não implementamos neste incremento exclusão de lançamentos/contas, alterações arbitrárias de valores/datas, criação de transferências ou pagamento bancário. Não existe ferramenta de movimentação de dinheiro. O cadastro conecta-se ao orçamento; não cria uma nova base nem configura o Pluggy.

## Conciliador das 9h

A rotina roda no próprio container Debian; não depende de o Windows ou o Codex ficar aberto. Reutiliza a fila durável, o mecanismo de categorização, as confirmações, a auditoria e os backups existentes.

- O horário é civil, no fuso do usuário, com tratamento de horário de verão pela biblioteca de datas já existente.
- Cada ocorrência é persistida e deduplicada. Reiniciar o container não repete uma classificação aplicada. Ao voltar de uma indisponibilidade, executa a última ocorrência devida, não uma enxurrada de dias antigos.
- Lê o dia anterior e revisita até sete dias para importações atrasadas. Usa até 12 meses de histórico como evidência para sugestões.
- Analisa entradas e saídas sem categoria. Classificações já existentes não são sobrescritas automaticamente.
- Recebimentos pedem confirmação: uma regra antiga de despesas do mesmo favorecido não comprova que um PIX recebido seja reembolso, renda ou empréstimo. Escrita automática é limitada às saídas elegíveis.
- Escrita automática exige uma única categoria elegível, sem conflito, com escore pelo menos 0,95: regra local explícita ou pelo menos cinco exemplos confirmados, com concordância mínima de 90%. Esse escore é um critério de evidência, não uma probabilidade de acerto.
- Texto parecido, CPF recorrente, memória livre ou palpite do modelo, sozinhos, não autorizam gravação automática. Histórico comum serve de sugestão e pede confirmação.
- Até 20 classificações automáticas e 3 perguntas por rodada. O excedente permanece pendente; `/sem_categoria` permite revisá-lo. Pendências mais antigas que sete dias exigem revisão manual.
- Transferências vinculadas, saldos iniciais, contas encerradas/fora do orçamento e lançamentos divididos não são alterados automaticamente.
- Cada escrita relê o alvo, verifica se houve mudança concorrente, salva backup criptografado e confirma o resultado. Resultado incerto não é repetido automaticamente.
- O resumo inclui entradas, saídas, saldo dos movimentos, classificações, pendências e resultados incertos. Os totais excluem transferências vinculadas e saldos iniciais. Compras de cartão contam na data do lançamento; não equivalem ao débito bancário daquele dia.
- A rotina sincroniza com o **servidor Actual**. Não força uma nova coleta do Pluggy; lançamentos ainda não importados pelo banco não podem aparecer no resumo.

Comandos:

```text
/conciliador
/conciliador ligar 09:00
/conciliador desligar
/operacoes
/desfazer ID_DA_OPERACAO
/lote
```

`/desfazer` prepara uma restauração da categorização, sujeita à confirmação e a verificações de estado. Lotes têm seu próprio acompanhamento em `/lote`. Backups completos exigem recuperação administrativa. Desligar o conciliador não desfaz operações concluídas.

## Memórias solicitadas

```text
Lembre-se de que recebo meu salário no dia 5.
Guarde isso.
/memorias
Esqueça a memória sobre o salário.
/esquecer ID
/ia limpar
```

A IA apresenta uma proposta e só grava após confirmação. “Guarde isso” usa a mensagem anterior do usuário como candidata, não uma interpretação silenciosa; confirme somente se a prévia representar o que quis dizer. Se não houver contexto, pede o conteúdo.

As memórias são separadas por usuário **e orçamento**, com validade padrão de 180 dias. Memórias de uma base não são copiadas para a esposa ou para outro orçamento. Os limites de contexto existentes continuam valendo; não prometemos lembrança ilimitada.

“Esqueça” remove a memória do contexto ativo e limpa o histórico curto daquela conversa. Se houver mais de uma correspondência, solicita o ID. O registro local de auditoria é preservado: não é uma solicitação de apagamento físico de todo o histórico, backups ou mensagens já existentes no Telegram.

## Credenciais e isolamento

- Registro: `/data/onboarding/registry.sqlite`, no volume `finaissistent_state`.
- Configuração e segredos cadastrados: AES-256-GCM, com autenticação vinculada ao ID do usuário. A chave mestra está em `/run/secrets/onboarding-key`, fora do banco.
- Somente durante a execução, credenciais são materializadas em `/tmp/finaissistent-onboarding`, no tmpfs do container, com permissões restritas. O administrador/root do servidor pode acessá-las: a criptografia não oculta segredos do próprio servidor em execução.
- Novos usuários têm caches, estado, conversas e auditoria separados por ID e orçamento.
- Convites são aleatórios, persistidos por hash; código validado por HMAC, com bloqueio após cinco erros. Links/códigos pendentes na fila são criptografados.
- O segredo do convite usa o fragmento `#...`, removido da barra de endereço pelo formulário. Não é enviado no caminho HTTP nem salvo em armazenamento local do navegador.
- Servidores Actual permitidos são uma lista administrada, não URLs arbitrárias fornecidas pelo usuário.
- Limite inicial: 20 cadastros. Não há isolamento por container entre usuários; trata-se de isolamento lógico de um piloto, não de uma plataforma pública multiempresa pronta.
- As credenciais legadas continuam nos arquivos existentes. Não foram copiadas para o Windows nem expostas na conversa.

Com Gemini, perguntas, contexto autorizado e dados financeiros necessários podem ser enviados ao Google. A chave autentica a API, não faz parte do prompt. Para dados pessoais/sensíveis, observe a diferença entre serviços gratuitos e pagos nos [termos oficiais do Gemini](https://ai.google.dev/gemini-api/terms). A aplicação não verifica se o faturamento está ativo. Ollama usa o modelo local já configurado.

## Instalação e atualização

Pré-requisitos: instalação FinAIssistent existente, Docker Compose, `config.json`, pasta `secrets`, acesso do usuário Unix ao Docker e UID/GID 1000 para os arquivos usados pelo container.

```bash
cd /home/agis/FinAIssistent
docker build --target runtime -t finaissistent:onboarding-20260923 .
bash scripts/enable-onboarding.sh 10.11.46.109 financa-hml2
docker compose -f compose.yaml -f compose.override.yaml -f compose.onboarding.yaml ps
```

O instalador reaproveita configuração e volumes, gera chave mestra e certificado **somente se ausentes**, e publica a entrada nova. Não substitua a chave mestra em uma atualização: cadastros existentes deixariam de ser legíveis. Guarde backup protegido dessa chave junto com uma cópia consistente do registro.

Em outra máquina, informe o IP correto. Se a homologação tiver outro alias, informe-o. O formulário permite escolher a segunda instalação Actual, porta 5007, sem copiar categorias, CPFs, memórias ou regras particulares do administrador.

Parâmetros de implantação em `compose.onboarding.yaml`/ambiente: `ONBOARDING_PUBLIC_URL`, `ONBOARDING_BIND`, `ONBOARDING_PORT`, `ONBOARDING_ACTUAL_URLS` (separadas por vírgula), `ONBOARDING_MAX_USERS`, `ONBOARDING_DAILY_BASE`, `ONBOARDING_PILOT_UNTIL`, caminhos da chave mestra/certificado. Trocar o IP exige certificado que inclua esse IP e ajuste do endereço público. HTTP exige habilitação expressa e não é recomendado para senhas.

O ponto de entrada antigo `src/main.mjs` continua disponível. Subir somente `compose.yaml` inicia o modo antigo; use o arquivo adicional para manter o cadastro web.

## Backup e rollback desta implantação

Antes da atualização foram gerados snapshots criptografados do estado das duas bases:

- `principal`: backup `b9f09f5f-beab-4b83-92cf-833255708767`.
- `financa-hml2`: backup `e78b3795-cd4d-4029-aa09-48407a660834`.
- Manifesto: `/data/deployment-manifests/onboarding-20260923.json`.
- Imagem anterior preservada: `finaissistent:before-onboarding-20260923`.

Para voltar apenas o software, use o override de rollback preparado:

```bash
cd /home/agis/FinAIssistent
docker compose -f compose.yaml -f compose.override.yaml -f compose.rollback-onboarding.yaml up -d --no-build bot
```

Não use `docker compose down -v`: isso apagaria volumes. O estado e os cadastros novos ficam preservados para investigação, sem restaurar um snapshot antigo por cima de mensagens recentes. O modo antigo atende apenas o administrador e não serve a página de cadastro.

Se for necessário restaurar dados, pare o bot, guarde primeiro um backup do estado atual e siga [backups.md](backups.md). Não restaure automaticamente snapshots antigos: o bot pode ter recebido confirmações e feito alterações legítimas depois deles. A implantação não modificou lançamentos financeiros para testar a interface.

## Verificação realizada

- A primeira versão passou em 441 testes; a revisão final de conversa passou em **451 testes, zero falhas**, incluindo isolamento, convite de uso único, código incorreto, credencial criptografada, origem HTTP, memórias, agendamento no fuso, descrições cotidianas, escrita e deduplicação em dados sintéticos. Execução: `docker run --rm finaissistent:onboarding-verify`; log no host: `/tmp/finaissistent-onboarding-tests.log`.
- Teste de conversa na HML2: `check-conversation-ux.mjs` retornou `passed:true`, `financialMutations:0`, `modelCalls:0`. A descrição real com iFood apareceu na prévia e “foi delivery” encontrou a categoria existente; nenhuma confirmação financeira foi enviada.
- Página conferida em navegador; o seletor de IA foi corrigido durante essa verificação.
- Leitura real isolada da Financa-hml2 e validação da chave/modelo Gemini passaram depois da correção de horário; nenhuma escrita financeira nessa verificação.
- Container publicado saudável e `/health` HTTPS acessível do Debian e do Windows usando o certificado do piloto.
- Aguardamos o primeiro cadastro humano e a primeira ocorrência real das 9h. Testes sintéticos não substituem essa observação.

## Pendência operacional: relógio

Foi encontrado desvio aproximado de 1h03 no Debian. O Actual recusava baixar o orçamento com `clock-drift`. Com autorização explícita recebida no Telegram, a hora do host foi ajustada ao UTC verificado, usando um container descartável com a capacidade `SYS_TIME`; não houve mudança de datas dos lançamentos nem criação de um serviço privilegiado permanente.

O serviço NTP permanece habilitado, mas **não sincronizado**. Três servidores consultados por UDP/123 não responderam. Isso demonstra indisponibilidade do caminho NTP testado, mas não identifica sozinho se a causa é firewall, roteador ou política da rede. É necessário restabelecer NTP para evitar novo desvio. Não contornamos a proteção de relógio do Actual nem redefinimos o relógio interno do orçamento.

```bash
date -u
timedatectl timesync-status
timedatectl show -p NTP -p NTPSynchronized
```

## Canal temporário com a implementação

`/piloto TEXTO` grava uma resposta do administrador para acompanhamento enquanto a sessão de implementação estiver ativa. Está limitado ao administrador e expira em 24/09/2026 às 23:59, São Paulo. Não executa ordens financeiras e **não acorda o Codex após o encerramento da sessão**. A IA financeira normal e o conciliador continuam funcionando independentemente desse canal.

O script PowerShell de pareamento temporário foi preparado no início, mas não precisou receber uma nova chave: conseguimos enviar mensagens pelo bot existente. Não crie um segundo leitor `getUpdates` para o mesmo token.

## Registro de decisões — extensível

### Conversa para reconhecer e classificar lançamentos

Pedido de 23/09: não exigir nomes exatos de categorias nem exibir IDs de lançamentos na conversa cotidiana.

- Listas e perguntas mostram data brasileira, valor assinado, favorecido, observação bancária e conta. A observação não é descartada quando o banco informa apenas CPF ou intermediário. A finalidade continua desconhecida quando o extrato não a explica; não inventar estabelecimento.
- “Liste os itens sem categoria, linha a linha” executa uma consulta nova. Sem período informado, usa os últimos 12 meses-calendário até hoje, em páginas de dez. Transferências vinculadas, saldos iniciais e pais de divisões ficam fora dessa busca. “Próxima página” mantém os filtros da busca natural anterior.
- A pessoa pode dizer “2 foi lanche” ou tocar em “Explicar item” / “Explicar este lançamento” e depois escrever “lanche”. Selecionar um item vincula a próxima resposta à base de origem, mesmo que outra base estivesse ativa.
- O vocabulário cotidiano é comparado ao catálogo visível real. Na HML2, “lanche” encontra “Restaurantes, padarias e lanches”; “delivery” encontra “Delivery e refeições prontas”. Sinônimos são sugestões, não regras globais de escrita nem categorias criadas automaticamente.
- Havendo vários lançamentos sem alvo explícito, perguntar qual. Havendo várias categorias igualmente compatíveis, oferecer botões com nomes e grupos. Não escolher silenciosamente entre empates. Entradas exigem esclarecer renda, empréstimo ou reembolso antes de reaproveitar uma categoria de gasto.
- “Consumo” mantém sua finalidade especial definida pelo usuário. “Cerveja”, “vinho” e “álcool” não são sinônimos dessa categoria; origens particulares e regras anteriores não são substituídas.
- A proposta mostra nomes e grupos, sem UUIDs ou comandos de confirmação no texto. Os códigos continuam internos aos botões e à auditoria. Comandos administrativos de operações/rollback ainda podem apresentar códigos técnicos.
- Botões de seleção vencem em 24h; escolhas de categoria e propostas, em 15min. `/ia limpar` também invalida os botões de seleção dessa conversa. Nenhum desses botões substitui a confirmação final de escrita.

Implementação: `src/reports/transaction-card.mjs`, `src/conversation/category-language.mjs`, `src/conversation/service.mjs`, `src/conversation/store.mjs`, `src/jobs/transaction-monitor.mjs`, `src/telegram/base-router.mjs` e migração `012_conversation_choices.sql`. Cobertura nova em `test/category-language.test.mjs`, `test/assistant-tools.test.mjs` e `test/base-router.test.mjs`. O teste real `scripts/check-conversation-ux.mjs` é exclusivo da HML2 e usa um diário em memória, sem expor métodos de escrita financeira.

Ao adicionar novos termos, registrar a intenção, os destinos reais possíveis, ambiguidades e teste de aceitação. Nunca transportar IDs, CPFs ou exceções pessoais entre usuários.

### Correção: “os últimos 10 itens” não é uma seleção antiga

Ocorrência relatada após a revisão de conversa: “Liste os últimos 10 itens sem categoria por favor” recebeu “Não há lançamentos” e `rows: []`, sem nova leitura do Actual. A frase com quantidade e cortesia não correspondia ao interpretador direto anterior. A tentativa “Liste os 10 lançamentos sem categoria” também escapava desse interpretador e registrou `GEMINI_UNAVAILABLE` no histórico. São situações diferentes: seleção antiga vazia não comprova inexistência e provedor indisponível não significa orçamento vazio.

Correção em `src/conversation/search-intent.mjs` e `src/conversation/service.mjs`:

- Reconhecer quantidade em algarismos ou palavras, “itens”, “lançamentos”, “transações”, “últimos” antes/depois da quantidade e “por favor”. Preservar filtros de período e de categoria.
- Consultas diretas funcionam sem chamar o modelo, inclusive quando Gemini está indisponível/desabilitado; isso não troca o provedor escolhido para o restante da conversa nem envia contexto a outro serviço.
- Quantidades até dez definem o tamanho da página; pedidos maiores são apresentados em páginas de dez, com aviso. A próxima página mantém o tamanho e os filtros anteriores.
- Um pedido de listagem não interpretado diretamente precisa de uma ferramenta de leitura no mesmo turno. Sem essa leitura, informar que a consulta não ocorreu, sem afirmar ausência de dados.
- Listagens exibem o resultado autoritativo da consulta, sem acrescentar uma narrativa do modelo que possa contradizê-lo. Filtros não reconhecidos, como conta ou valor, não são descartados para forçar uma correspondência.

Regressões: frases reais, seleção antiga vazia, Gemini desabilitado, resultado ordenado, paginação de cinco, ausência de escrita e preservação de filtros adicionais. `scripts/check-latest-transactions.mjs` confere as duas frases na HML2 com diário isolado em memória, sem métodos de escrita nem chamadas à IA. O histórico antigo do bot fica preservado como evidência; respostas incorretas anteriores não são reescritas.

Verificação desta correção: `docker run --rm finaissistent:list-query-verify` terminou com **457 testes, 457 aprovados e zero falhas** (`/tmp/finaissistent-list-query-tests.log`). O teste real retornou `passed:true`, `totalMatching:19`, `returned:10`, `modelCalls:0` e `financialMutations:0` para ambas as frases. Período: 01/10/2025 a 23/09/2026; os dez retornados tinham datas entre 21 e 23/09/2026. Esses números são a observação desse teste, não uma contagem permanente do orçamento. Imagem da correção: `finaissistent:list-query-20260924`; o alias de implantação continua `finaissistent:onboarding-20260923`.

| Data | Decisão | Escopo |
| --- | --- | --- |
| 23/09/2026 | Reutilizar bot, SDK protegido, filas, auditoria e backups existentes | Evitar uma segunda implementação financeira concorrente |
| 23/09/2026 | Cadastro individual por Telegram, HTTPS por IP e credenciais criptografadas | Piloto em rede/VPN |
| 23/09/2026 | IA com escrita mediante proposta; conciliação automática com evidência forte | Categorias e metas/memórias suportadas |
| 23/09/2026 | Conciliador às 9h, ontem mais janela de atraso de sete dias | Financa-hml2; novos usuários optam no formulário |
| 23/09/2026 | Esquecer remove contexto ativo, preservando auditoria | Cada usuário e orçamento |
| 23/09/2026 | Corrigir hora do host, sem modificar relógio do orçamento | Autorização recebida em `/piloto` |
| 23/09/2026 | Explicar gastos com palavras cotidianas; IDs ficam internos às ações | Listas, perguntas do conciliador e propostas de categorias |

Para novas definições, acrescente data, pedido original, decisão, escopo, regra de automação/necessidade de confirmação, estratégia de rollback e teste de aceitação. Não converta exceções pessoais em regras globais.

Referências técnicas: [Telegram — funcionamento dos bots e links](https://core.telegram.org/bots/features#deep-linking), [Actual — API oficial](https://actualbudget.org/docs/api/), [Gemini — termos de dados](https://ai.google.dev/gemini-api/terms).
