# Backups cifrados

`src/backups/encrypted.mjs` cifra exports Actual e snapshots SQLite com AES-256-GCM. A escrita real depende de `backup.keyRef`, uma referência ao arquivo de segredo montado em `secretDir`; o valor da chave não entra no JSON de configuração nem no workerData. A leitura financeira funciona sem esse segredo.

## Chave

O arquivo referenciado contém exatamente **64 dígitos hexadecimais**, representando 32 bytes aleatórios, com uma quebra de linha final opcional. Gere com `node:crypto.randomBytes(32).toString('hex')` em ferramenta local confiável e escreva diretamente no arquivo montado, sem copiá-la para logs ou chat. Não use senha humana ou os valores repetidos dos testes: aqueles são dados sintéticos.

O resolver exige arquivo regular sem symlink, tamanho limitado e modo owner-only no POSIX. Em Windows, restrinja a ACL ao usuário de serviço/administradores responsáveis, conforme o runbook. Guarde uma cópia segura da chave separada dos backups: sem a chave correta não há recuperação. Ao rotacionar, preserve as chaves antigas necessárias; a leitura local pode usar configuração/resolver apontando à chave correspondente.

## Formato e persistência

Cada backup recebe UUID opaco e arquivo `dataDir/backups/<uuid>.bin`, sem nomes de contas ou favorecidos. A referência persistida contém ID, tipo (`actual` ou `state`), operationId, horário, tamanho e SHA-256 do arquivo cifrado.

Layout versão 1:

| Parte | Conteúdo |
|---|---|
| 8 bytes | Magic `FINAIB01` |
| 4 bytes | Tamanho big-endian do cabeçalho JSON |
| Cabeçalho | versão, ID opaco, tipo, operação, residência/orçamento e horário |
| 12 bytes | IV aleatório exclusivo desta cifra |
| 16 bytes | Tag de autenticação GCM |
| Demais bytes | Conteúdo cifrado |

Magic, tamanho e cabeçalho são autenticados como AAD. O cabeçalho não contém registros financeiros, mas sua identificação operacional fica legível. Leitura verifica hash externo, contexto, tamanho e tag; trocar a chave, alterar bytes ou reaproveitar a referência para outro contexto falha.

A pasta POSIX usa modo 0700 e arquivos 0600. A implementação recusa pasta de backup por symlink ou permissões abertas. Escreve o conteúdo **já cifrado** em arquivo exclusivo `.part`, executa fsync, fecha, renomeia no mesmo diretório e executa fsync do diretório no POSIX. Windows recebe flush do arquivo antes do rename; Node não disponibiliza o mesmo fsync de diretório nesse caminho. As garantias finais de persistência dependem do filesystem/volume. Um crash pode deixar um `.part` cifrado ou backup órfão; esses arquivos não autorizam repetir a operação.

Nenhum arquivo plaintext intermediário é criado. `backupState(store,options)` usa `better-sqlite3` `serialize()` para copiar o banco aberto, incluindo páginas WAL confirmadas, em memória antes da cifra. `writeEncryptedBackup(bytes,options)` recebe o `Uint8Array` do SDK; exports são limitados a 512 MiB. Buffers transitórios da chave e os snapshots recebidos pelo adaptador são limpos quando deixam de ser usados, sem promessa de apagamento de todas as cópias da VM.

## Recuperação local

`readEncryptedBackup(reference,{config,resolveSecret?})` é helper de recuperação local, não uma operação Telegram/RPC. Retorna Buffer somente depois da autenticação. O teste de estado abre esses bytes com `new Database(bytes)` e verifica o valor anterior; o teste SDK importa os bytes decifrados com `api.importBudget(bytes,{type:'actual'})` em orçamento descartável e verifica a restauração.

O ZIP de `exportBudget()` contém banco e metadados em claro antes da cifra; não o envie por chat e não o grave em logs. A restauração integral é procedimento de manutenção deliberado, com serviço parado e contexto conferido; não é rollback automático para uma alteração de categoria. O undo de categoria escreve apenas o campo anterior mediante nova pré-condição/aprovação. [Referência oficial de export/import](https://actualbudget.org/docs/api/reference/#exportbudget).

`test/backups.test.mjs` cobre roundtrip, bytes aleatórios por backup, ausência de texto original no arquivo, chave/contexto incorretos, hash/tag adulterados, referência de caminho inválida, snapshot SQLite e permissões/symlinks POSIX. `test/sdk-mutations.test.mjs` verifica export Actual cifrado → decifra → import e comparação dos registros originais. Não há teste de restauração de servidor real ou perda física de energia.

## Retenção manual dos arquivos

Não existe limpeza automática de `dataDir/backups` nesta fase. `retentionDays` controla os dados do SQLite, não os arquivos `.bin` ou `.part`. Um backup é uma cópia integral do estado na sua criação: minimizar dados no banco ativo não os apaga de backups anteriores. A responsabilidade de definir a janela dos arquivos e realizar a manutenção é do operador.

Procedimento de manutenção local:

1. Pare o serviço para impedir que a lista de operações e backups mude durante a revisão. Confira o caminho absoluto de `dataDir/backups` e o contexto de residência/orçamento do banco antes de selecionar arquivos.
2. Consulte, em ferramenta SQLite local, `operations.state_backup_ref` e `operations.actual_backup_ref`, os estados e `initial_outcome`. Faça um inventário protegido somente com UUID, tipo, operação, criação, tamanho e hash das referências. Identifique arquivos sem referência separadamente; um `.part` ou `.bin` órfão não prova que a operação falhou antes do patch.
3. Defina o corte de retenção no inventário. Preserve os backups de operações `reserved`, `executing` ou `uncertain` e os necessários a qualquer investigação/restauração pendente. Para `observed_before`/`observed_after` de origem incerta, registre a decisão de encerramento da investigação antes de incluí-los na lista de remoção: a observação não prova autoria. Preserve também uma cópia recuperável escolhida para cada orçamento e as chaves necessárias às cópias retidas.
4. Antes de remover cópias antigas, confira a referência e a autenticação das cópias que serão retidas usando `readEncryptedBackup` em ambiente local protegido. Quando necessário, teste a restauração em orçamento/banco descartável isolado, conforme a seção anterior. Não publique o Buffer decifrado nem inclua seu conteúdo no inventário.
5. Remova somente os arquivos explicitamente selecionados no inventário, depois de verificar que são arquivos regulares no diretório absoluto esperado, sem links e com os UUIDs conferidos. Não remova a pasta inteira, o banco ativo ou arquivos apenas por parecerem antigos. Arquivos órfãos/parciais exigem decisão separada após a investigação. Registre quais UUIDs foram removidos e quando em um registro local de manutenção protegido; conserve as referências históricas do journal como metadados.
6. Confira que os arquivos e as chaves retidos continuam disponíveis e reinicie o serviço. Uma cópia removida deixa de ser recuperável por sua referência; a limpeza não autoriza repetir operações incertas.

Este procedimento é manual e não foi executado em dados de produção pelos testes. Excluir um arquivo também não comprova apagamento físico de blocos, snapshots do volume ou cópias externas; a retenção desses meios pertence à política de armazenamento do operador.
