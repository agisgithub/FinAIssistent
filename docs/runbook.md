# Operação e recuperação

## Preparar o ambiente

1. Use Node.js 24 ou a imagem Docker deste repositório. Instale com `npm ci`; mantenha o lockfile. O SDK Actual está fixado em 26.9.0; valide a compatibilidade do servidor em um orçamento sintético antes de conectar o orçamento pessoal.
2. Use bot, diretórios de dados, cache Actual e banco SQLite exclusivos desta aplicação. Não compartilhe o volume com outra cópia do bot nem com outro cliente SDK. Use filesystem local com locks de arquivo, não NFS.
3. Copie e ajuste `config.example.json`. O `budgetId` é o **Sync ID**, não o nome exibido do orçamento. IDs do Telegram são números inteiros; o MVP requer conversa privada com `userId === chatId`.
4. Crie `secrets/telegram-token`, `secrets/actual-password` e, se necessário, o segredo de criptografia do orçamento. Coloque uma linha por arquivo. O último newline é removido, mas espaços no valor são preservados.
5. Em Linux, dono e permissões precisam corresponder ao processo: pasta privada, arquivo `0600`/`0400`. Em Docker a imagem usa UID/GID 1000, arquivos montados somente para leitura. Em Windows, use a guia Segurança das propriedades para remover acesso herdado amplo e conceder leitura à conta que executa o bot; confira as ACLs antes de uso real. Não cole os valores em comandos compartilhados, logs ou mensagens.
6. Para Docker, configure `/data` e `/run/secrets` no JSON. `actual.serverURL` deve ser alcançável a partir do container; `localhost` dentro dele se refere ao próprio container. O compose não publica portas. O servidor Actual é uma implantação separada.
7. Execute os testes. Inicie com `npm start` ou `docker compose up --build -d`. Teste `/status`, `/contas`, `/gastos` pelo usuário autorizado e confira os valores no Actual.

A aplicação consulta `getWebhookInfo` e recusa inicialização se houver webhook. Ajuste conscientemente a configuração do bot que será usado para polling; a aplicação não apaga um webhook existente. O bot precisa ter uma conversa privada iniciada pelo responsável.

## Verificações

```sh
npm run check
npm test
npm run test:sdk
docker compose -f compose.test.yaml run --build --rm tests
```

O job CI `node` verifica sintaxe e testes; o job `container` executa a mesma suíte sem rede, como usuário sem privilégios, e constrói a imagem de execução. O healthcheck valida um heartbeat local recente (até 180s); não comprova disponibilidade de Actual/Telegram. `/status` mostra última leitura e estados incertos.

Os testes POSIX de permissões e symlink aparecem como ignorados no Windows. O teste de crash real do processo pode aparecer como ignorado se o sandbox do host bloquear criação de subprocessos (`EPERM`); o CI Linux deve executá-lo. O teste de contenção de conexões SQLite não depende de subprocesso e roda em ambos os ambientes.

O SDK 26.9.0 é carregado com uma transformação restrita em memória que impede seu serviço automático de agendas durante consultas e escritas autorizadas. Uma divergência de versão, hash ou cache aborta com `ACTUAL_FAILED` antes de resolver segredos. Confira Node 24 e reinstale os artefatos exatos com `npm ci`; não remova a proteção nem altere `posts_transaction`/`lastScheduleRun` no orçamento para contornar a falha. Uma atualização do SDK exige revisão da fonte e o teste `test/sdk-safety.test.mjs`, junto dos testes de leitura/mutação. Detalhes e hash aprovado estão no [contrato Actual](actual-contract.md#proteção-contra-execução-automática-de-agendas).

## Códigos operacionais

| Código | Ação |
| --- | --- |
| `CONFIG_INVALID` | Confira schema/IDs e o vínculo existente; não apague o banco para forçar uma mudança sem revisar o histórico |
| `SECRET_UNAVAILABLE` / `SECRET_PERMISSIONS` | Confira arquivo, referência, dono e acesso da conta do processo |
| `ALREADY_RUNNING` | Outra instância pode deter o lock do volume; pare a instância duplicada e confirme filesystem local. Não remova o arquivo de lock |
| `TELEGRAM_WEBHOOK_ACTIVE` | Há webhook configurado no bot escolhido; reveja o modo de recebimento |
| `ACTUAL_FAILED` / `ACTUAL_SYNC_FAILED` | Confira servidor, credencial, orçamento e compatibilidade. Um sync falho não produz total novo |
| `ACTUAL_TIMEOUT` | A requisição expirou. Após terminação confirmada, o próximo trabalho pode criar outro worker. Se a terminação falhar, reinicie sob supervisão; o cache deve continuar exclusivo |
| `TELEGRAM_REJECTED` | Telegram rejeitou a entrega; confira acesso ao chat e configuração. O conteúdo do erro remoto não entra no log |
| `TELEGRAM_RATE_LIMITED` | Rejeição explícita 429: respeita `retry_after` validado, com no máximo cinco tentativas. Demais mensagens aguardam o mesmo prazo |
| `DELIVERY_UNCERTAIN` | Confira a conversa antes de qualquer reenvio manual. A mensagem pode ter chegado |

Rotação do token do mesmo bot preserva o ID e o cursor. Para trocar de bot ou orçamento, use uma implantação com estado novo depois de revisar/exportar o histórico anterior; não há rebind implícito neste marco.

Após 48h sem updates recebidas, o polling abandona o cursor antigo e a próxima update inicia uma nova época de deduplicação. Isso permite receber IDs menores após longos períodos de inatividade, sem confundi-los com mensagens históricas.

## Encerrar e reiniciar

SIGINT/SIGTERM cancela o polling, aguarda trabalhos em andamento, fecha o SDK e o SQLite e libera o lock. O compose reserva 150s para encerramento; o timeout padrão do Actual é 120s. Se você aumentar esse timeout, aumente também o período de encerramento.

Depois de crash, o lock SQLite é liberado pelo SO. Na inicialização, leituras interrompidas voltam à fila; trabalhos marcados não repetíveis e envios iniciados ficam incertos. Não há repetição automática de uma escrita ou envio com resultado desconhecido.

## Backup e restauração

O método `StateStore.backup(filename)` usa o backup consistente do driver e é exercitado pelo teste de restauração. Para backup operacional simples deste marco, pare a aplicação, confirme o encerramento e copie `state.sqlite`, `state.sqlite-wal` e `state.sqlite-shm` se existirem, preservando dono/permissões. Não copie só o arquivo principal de um banco WAL em uso. `runtime-lock.sqlite` é coordenação temporária e não entra no backup.

Guarde separadamente a configuração sem valores secretos e as referências necessárias à recuperação. Cifre o backup antes de transferi-lo para outro local. O cache Actual pode ser baixado novamente do servidor; a política de backup do orçamento no próprio Actual continua necessária. Não envie esses arquivos pelo bot.

Para restaurar, pare a aplicação, restaure em **outro diretório local isolado**, configure a mesma identidade/bot/orçamento e execute as verificações sintéticas de estado antes de iniciar polling. Não execute duas cópias do bot ao testar uma restauração. Os segredos precisam ser provisionados pelo canal seguro do ambiente; não estão embutidos no backup da aplicação.

Fontes: [backup e transações do driver](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md), [SQLite WAL](https://www.sqlite.org/wal.html), [SQLite locking](https://www.sqlite.org/lockingv3.html).
