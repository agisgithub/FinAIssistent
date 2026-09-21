# Operação e recuperação

Para preparar o servidor pela primeira vez ou corrigir `CONFIG_INVALID` após um build Docker, siga o [guia de instalação, credenciais e testes](docker-install.md). Ele preserva configuração/volumes existentes e diferencia o pré-teste local da conexão real ao Telegram e Actual.

## Preparar o ambiente

Para ajustar somente modelos e chave de IA, use `bash scripts/configure-ai.sh` no Docker/Linux ou `npm run setup:ai` com Node. O processo preserva as configurações Actual/Telegram/backup e override. A chave Gemini é digitada com entrada oculta; não passe como argumento, variável de ambiente ou mensagem Telegram. A configuração e a [política de exportação consciente de contexto](conversation.md) são separadas da confirmação financeira.

1. Use Node.js 24 ou a imagem Docker deste repositório. Instale com `npm ci`; mantenha o lockfile. O SDK Actual está fixado em 26.9.0; valide a compatibilidade do servidor em um orçamento sintético antes de conectar o orçamento pessoal.
2. Use bot, diretórios de dados, cache Actual e banco SQLite exclusivos desta aplicação. Não compartilhe o volume com outra cópia do bot nem com outro cliente SDK. Use filesystem local com locks de arquivo, não NFS.
3. Copie e ajuste `config.example.json` para Node.js ou `config.docker.example.json` para Docker, somente se ainda não houver `config.json`. O `budgetId` é o **Sync ID**, não o nome exibido do orçamento. IDs do Telegram são números inteiros; o MVP requer conversa privada com `userId === chatId`.
4. Crie `secrets/telegram-token`, `secrets/actual-password` e, se necessário, o segredo de criptografia do orçamento. Coloque uma linha por arquivo. O último newline é removido, mas espaços no valor são preservados.
5. Em Linux, dono e permissões precisam corresponder ao processo: pasta privada, arquivo `0600`/`0400`. Em Docker a imagem usa UID/GID 1000, arquivos montados somente para leitura. Em Windows, use a guia Segurança das propriedades para remover acesso herdado amplo e conceder leitura à conta que executa o bot; confira as ACLs antes de uso real. Não cole os valores em comandos compartilhados, logs ou mensagens.
6. Para Docker, configure `/data` e `/run/secrets` no JSON. `actual.serverURL` deve ser alcançável a partir do container; `localhost` dentro dele se refere ao próprio container. O compose não publica portas. O servidor Actual é uma implantação separada.
7. Execute `npm run preflight` ou `docker compose run --rm --no-deps bot node scripts/preflight.mjs` depois de construir a imagem. Esse diagnóstico não usa rede; não comprova senha correta nem disponibilidade remota. Corrija as falhas, execute os testes e inicie com `npm start` ou `docker compose up -d bot`. Teste `/status`, `/contas`, `/gastos` pelo usuário autorizado e confira os valores no Actual.

O monitor de novas transações fica desligado por padrão. Para iniciar somente perguntas, pare o bot, faça backup do SQLite/configuração, defina `companion.transactionMonitorEnabled:true` e reinicie; a primeira leitura completa é um baseline silencioso. Só depois de conferir o baseline e as perguntas, habilite escrita automática com `dryRun:false`, `backup.keyRef` válido e `companion.autoCategorizeHighConfidence:true`. `/status` mostra o modo e a última varredura. Para interromper, volte ambas as flags a `false`; jobs já incertos continuam tombstones e não devem ser repetidos.

A aplicação consulta `getWebhookInfo` e recusa inicialização se houver webhook. Ajuste conscientemente a configuração do bot que será usado para polling; a aplicação não apaga um webhook existente. O bot precisa ter uma conversa privada iniciada pelo responsável.

## Diagnosticar a inicialização

```sh
docker compose stop bot
docker compose config --quiet
docker compose run --rm --no-deps bot node scripts/preflight.mjs
```

O pré-teste imprime resultados estruturados sem valores secretos; termina com código `0` quando passa, `1` quando há falha e `2` para uso inválido da CLI. A escrita de prova usa um arquivo temporário próprio, sem modificar o SQLite. Execute-o como o usuário normal da imagem para testar as permissões reais. `docker compose config --quiet` valida o Compose, não o JSON da aplicação.

Confira `config.json` como arquivo real, JSON válido, caminhos Docker `/data` e `/run/secrets`, IDs preenchidos e arquivos privados acessíveis ao UID 1000. O Compose rejeita origens ausentes para configuração e segredos; não as cria como pastas. O [guia](docker-install.md#2-garantir-que-a-configuração-seja-um-arquivo) trata uma pasta `config.json` criada por uma versão anterior sem apagar dados.

Com o bot parado, `docker compose run --rm --no-deps bot node scripts/telegram-info.mjs` verifica o token montado e mostra apenas IDs de conversas privadas, após você enviar `/start`. A ferramenta usa rede Telegram, mas não envia mensagens, remove webhook ou avança o cursor. Não substitui a seleção consciente do responsável nem a prova de conexão ao Actual.

Depois da correção, use `docker compose up -d bot` e confira `docker compose logs --tail=80 bot`. `CONFIG_INVALID` com campos corretos também pode indicar incompatibilidade com a identidade já gravada (residência, orçamento, responsável/chat ou bot). Preserve o banco e sua configuração anterior para revisar esse vínculo; não use remoção de volumes como tratamento.

## Verificações

```sh
npm run check
npm test
npm run test:sdk
node --test --test-isolation=none test/sdk.test.mjs test/sdk-mutations.test.mjs test/sdk-safety.test.mjs test/sdk-schedules.test.mjs
docker compose -f compose.test.yaml run --build --rm tests
```

O job CI `node` verifica sintaxe e testes; o job `container` executa a mesma suíte sem rede, como usuário sem privilégios, e constrói a imagem de execução. Depois, o [teste da imagem de execução](../scripts/smoke-runtime.mjs) roda o pré-teste como UID 1000, com sistema de arquivos raiz somente para leitura, rede bloqueada e arquivos sintéticos; confere erros de configuração sem expor valores e preservação dos dados. O healthcheck valida um heartbeat local recente (até 180s); não comprova disponibilidade de Actual/Telegram. `/status` mostra última leitura e estados incertos.

`test:sdk` executa o teste básico `sdk.test.mjs`; o comando seguinte cobre também mutação, proteção de agendas e catálogo. `npm test` inclui todos eles e o [aceite público de recorrências](../test/mvp-bills-acceptance.test.mjs). Consulte o resultado de CI do SHA que será implantado; um teste local não comprova a imagem ou as credenciais de produção.

Os testes POSIX de permissões e symlink aparecem como ignorados no Windows. O teste de crash real do processo pode aparecer como ignorado se o sandbox do host bloquear criação de subprocessos (`EPERM`); o CI Linux deve executá-lo. O teste de contenção de conexões SQLite não depende de subprocesso e roda em ambos os ambientes.

O SDK 26.9.0 é carregado com uma transformação restrita em memória que impede seu serviço automático de agendas durante consultas e escritas autorizadas. Uma divergência de versão, hash ou cache aborta com `ACTUAL_FAILED` antes de resolver segredos. Confira Node 24 e reinstale os artefatos exatos com `npm ci`; não remova a proteção nem altere `posts_transaction`/`lastScheduleRun` no orçamento para contornar a falha. Uma atualização do SDK exige revisão da fonte e o teste `test/sdk-safety.test.mjs`, junto dos testes de leitura/mutação. Detalhes e hash aprovado estão no [contrato Actual](actual-contract.md#proteção-contra-execução-automática-de-agendas).

## Códigos operacionais

| Código | Ação |
| --- | --- |
| `CONFIG_INVALID` | Execute o pré-teste e confira campo/motivo estáticos, arquivo/JSON/caminhos/IDs e o vínculo existente; não apague o banco para forçar uma mudança sem revisar o histórico |
| `SECRET_UNAVAILABLE` / `SECRET_PERMISSIONS` | Confira arquivo, referência, dono e acesso da conta do processo |
| `ALREADY_RUNNING` | Outra instância pode deter o lock do volume; pare a instância duplicada e confirme filesystem local. Não remova o arquivo de lock |
| `TELEGRAM_WEBHOOK_ACTIVE` | Há webhook configurado no bot escolhido; reveja o modo de recebimento |
| `ACTUAL_FAILED` / `ACTUAL_SYNC_FAILED` | Confira servidor, credencial, orçamento e compatibilidade. Um sync falho não produz total novo |
| `ACTUAL_TIMEOUT` | A requisição expirou. Após terminação confirmada, o próximo trabalho pode criar outro worker. Se a terminação falhar, reinicie sob supervisão; o cache deve continuar exclusivo |
| `TELEGRAM_REJECTED` | Telegram rejeitou a entrega; confira acesso ao chat e configuração. O conteúdo do erro remoto não entra no log |
| `TELEGRAM_RATE_LIMITED` | Rejeição explícita 429: respeita `retry_after` validado, com no máximo cinco tentativas. Demais mensagens aguardam o mesmo prazo |
| `DELIVERY_UNCERTAIN` | Confira a conversa antes de qualquer reenvio manual. A mensagem pode ter chegado |
| `BILL_NOT_FOUND` | Copie um ID exibido em `/unidades`, `/recorrencias` ou `/proximos_vencimentos` |
| `BILL_CONFLICT` | O cadastro, ocorrência ou atribuição mudou; leia novamente e prepare outra proposta |
| `BILL_EVIDENCE_STALE` | Releia catálogo/histórico e revise os IDs; suporte antigo não autoriza confirmar a proposta |
| `CHAT_CONTEXT_LIMIT` | O corpo completo excedeu o contexto. Limpe histórico com `/ia limpar`, refine a consulta ou configure modelo com maior capacidade; não remova filtros para forçar resposta |
| `OLLAMA_MODEL_UNSAFE` | Confira GGUF local, `tools`, contexto e cloud desativado; `/ia modelos` lista apenas os candidatos aprovados |
| `GEMINI_REJECTED` / `GEMINI_RATE_LIMITED` | Confira chave de autorização, disponibilidade do modelo, projeto/billing/cotas no AI Studio; não existe fallback remoto nem retry automático |
| `GEMINI_TIMEOUT` / `GEMINI_UNAVAILABLE` | Consulta não concluída. Pode ter consumido cota; tente novamente conscientemente ou escolha Ollama |
| `CHAT_INVALID_RESPONSE` | Corpo inválido, resultado incompleto ou contrato incompatível; nenhuma ferramenta parcial foi aceita |
| `PROPOSAL_EXPIRED` / `PROPOSAL_USED` / `PROPOSAL_POLICY_CHANGED` | Prepare outra proposta após conferir os dados e a configuração; não reutilize o código |

Rotação do token do mesmo bot preserva o ID e o cursor. Para trocar de bot ou orçamento, use uma implantação com estado novo depois de revisar/exportar o histórico anterior; não há rebind implícito neste marco.

Após 48h sem updates recebidas, o polling abandona o cursor antigo e a próxima update inicia uma nova época de deduplicação. Isso permite receber IDs menores após longos períodos de inatividade, sem confundi-los com mensagens históricas.

## Ativar o calendário local

1. Crie uma unidade com `/unidade cadastrar nome="Apartamento"`, confira a proposta e confirme pelo botão ou `/recorrencia confirmar CODIGO`. Copie o ID de `/unidades`.
2. Consulte `/contas` e `/recorrencias favorecidos`. Prepare um cadastro usando os IDs exatos, competência, dia, offset, data confirmada/estimada e valor conhecido/desconhecido. O [guia](recurrences.md#começar-pelo-telegram) contém a sintaxe completa. Cadastro novo confere conta/favorecido em leitura fresca.
3. Confira a proposta antes de confirmar. Lembretes e variação começam desligados. Para habilitar avisos, use `lembretes=sim` no cadastro ou em uma edição com `a_partir=YYYY-MM`; padrão 7/3/1 dias às 08:00 no fuso financeiro. Essas escolhas são independentes de `/preferencias` dos relatórios.
4. Consulte `/proximos_vencimentos [YYYY-MM]` e `/ocorrencia ID`. Confira competência e vencimento separadamente. Um dia estimado não comprova dívida; a chegada de documento permanece não verificada.

`dryRun:true` simula a escrita de categoria no Actual, mas **salva as alterações locais confirmadas**, inclusive pago/reabrir/cancelamento. `/pago ID data=YYYY-MM-DD` prepara uma declaração manual; somente a confirmação muda o estado e cancela avisos pendentes. Sem `data`, ela permanece ausente. Reabrir também exige confirmação e não desfaz pagamento bancário. Não use uma instância de teste ligada ao mesmo bot/estado para experimentar esses comandos.

`/recorrencias atualizar`, `pendencias` e `candidatos` precisam de Actual disponível e dados completos. `/recorrencias agendamentos` lê fontes observadas; um cadastro baseado nelas continua mensal, conforme seus campos confirmados. A regra semanal/anual, o fim após N ocorrências e os ajustes de fim de semana do SDK não são importados automaticamente.

## Indisponibilidade e avisos de contas

O calendário e os lembretes já cadastrados funcionam sem nova leitura Actual e sem modelo. Uma leitura de reconciliação lenta tem fila separada e não bloqueia o tick/entrega local. Com Actual indisponível, não há nova evidência de compatibilidade nem alerta de variação baseado em cache; consulte `/recorrencias atualizar` quando quiser verificar novamente. Uma consulta financeira pode continuar indisponível se não existir snapshot compatível, enquanto `/proximos_vencimentos` mostra o calendário local.

No reinício, considera-se apenas a última etapa de lembrete devida por ocorrência/revisão/política, sem etapas anteriores à ativação. Datas confirmadas permitem um aviso de atraso no dia seguinte; estimadas não o geram. A mensagem é conferida e atualizada antes da entrega. Pagamento/cancelamento/pausa ou edição aplicável invalidam avisos pendentes, inclusive os adiados por 429. Envio já iniciado pode ter ocorrido; `uncertain` não é repetido automaticamente.

Para desligar avisos de uma recorrência, prepare `editar ID a_partir=YYYY-MM lembretes=nao variacao=nao` e confirme. `/recorrencia pausar ID` aplica pausa desde a competência atual. Edição futura preserva a política de competências anteriores. Encurtar `fim` conserva histórico e alterações específicas, mas ocorrências abertas fora da faixa deixam a agenda. Consulte [versões e estados](recurrences.md#campos-de-cadastro-e-edição) antes de retomar um cadastro.

## Atualizar o estado existente

A inicialização aplica a migração `004_bills.sql` depois de 001–003. Ela cria tabelas de unidades, versões, ocorrências, propostas e avisos; não ativa lembretes por conta própria. O teste de upgrade preserva dados e preferências anteriores. Antes da atualização operacional, pare a aplicação e faça o backup descrito abaixo. Preserve a mesma identidade/configuração; não apague o banco para solucionar uma falha de migração. Não execute simultaneamente as versões antiga e nova no mesmo volume.

## Encerrar e reiniciar

SIGINT/SIGTERM cancela o polling, aguarda trabalhos em andamento, fecha o SDK e o SQLite e libera o lock. O compose reserva 150s para encerramento; o timeout padrão do Actual é 120s. Se você aumentar esse timeout, aumente também o período de encerramento.

Depois de crash, o lock SQLite é liberado pelo SO. Na inicialização, leituras interrompidas voltam à fila; trabalhos marcados não repetíveis e envios iniciados ficam incertos. Não há repetição automática de uma escrita ou envio com resultado desconhecido.

## Backup e restauração

O método `StateStore.backup(filename)` usa o backup consistente do driver e é exercitado pelo teste de restauração. Para backup operacional simples deste marco, pare a aplicação, confirme o encerramento e copie `state.sqlite`, `state.sqlite-wal` e `state.sqlite-shm` se existirem, preservando dono/permissões. Não copie só o arquivo principal de um banco WAL em uso. `runtime-lock.sqlite` é coordenação temporária e não entra no backup.

Guarde separadamente a configuração sem valores secretos e as referências necessárias à recuperação. Cifre o backup antes de transferi-lo para outro local. O cache Actual pode ser baixado novamente do servidor; a política de backup do orçamento no próprio Actual continua necessária. Não envie esses arquivos pelo bot.

Para restaurar, pare a aplicação, restaure em **outro diretório local isolado**, configure a mesma identidade/bot/orçamento e execute as verificações sintéticas de estado antes de iniciar polling. Não execute duas cópias do bot ao testar uma restauração. Os segredos precisam ser provisionados pelo canal seguro do ambiente; não estão embutidos no backup da aplicação.

Fontes: [backup e transações do driver](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md), [SQLite WAL](https://www.sqlite.org/wal.html), [SQLite locking](https://www.sqlite.org/lockingv3.html).
