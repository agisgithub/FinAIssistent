# Autorização e privacidade

## Fronteiras

Um orçamento, uma residência e um responsável são vinculados ao banco da aplicação. Alterar esses IDs no JSON com um banco existente falha; uma configuração equivocada não mistura históricos. O ID público do bot obtido por `getMe` também é persistido: mudar para outro bot mantendo cursor/inbox antigos falha. Rotacionar o token do mesmo bot é compatível.

Só são aceitas mensagens privadas do usuário configurado, com chat igual ao destino configurado. Bots, grupos, chats desconhecidos, mensagens encaminhadas e callbacks sem a identidade/chat esperados são recusados. Um update recusado guarda apenas ID, horário e indicador de autorização para poder avançar o cursor, sem conteúdo.

Leituras são autorizadas pelo vínculo inicial; não pedem confirmação a cada uso. A única escrita implementada altera a categoria de um lançamento simples, mediante proposta específica de uso único. Não existe comando para chamar métodos arbitrários, executar código, pagar, transferir ou criar regras no Actual.

## Propostas e confirmação

`/categorizar <transactionId> <categoryId>` prepara uma proposta com identidade de usuário/chat/residência/orçamento, antes/depois, fingerprint versionado, categoria de destino completa, motivo, política e expiração de 15 minutos. O hash da política inclui servidor Actual, orçamento, modo de simulação, origem Telegram, versão, referências de backup e regras configuradas. O ID do job de origem é único: replay devolve a mesma proposta. Os IDs de categoria preservam maiúsculas/minúsculas.

O botão contém apenas um nonce aleatório de 18 bytes e a ação; seu callback tem 27 bytes, abaixo de 64. Identidade, nonce, validade, uso único e política são verificados no servidor. Texto e botão passam pelas mesmas regras. `/cancelar` torna a proposta inutilizável. Nomes externos são apresentados entre aspas, com controles e caracteres bidi removidos; grupos e IDs distinguem categorias homônimas.

Consumir a aprovação, reservar operação/item, desativar exemplos anteriores em modo real, marcar o job `safe_retry=0` e enfileirar o aviso de processamento ocorrem na mesma transação SQLite. Em seguida, a aplicação relê o alvo e o destino, faz backup cifrado do estado e chama somente `changeCategory` com precondição. O worker cria o backup cifrado do Actual e revalida após sincronizar. O destino precisa continuar com o mesmo ID, nome, grupo, tipo e visibilidade mostrados. O grupo não pode estar oculto.

Pais e filhos de splits, transferências, conta encerrada, conta fora do orçamento, saldo inicial e dados de elegibilidade ambíguos são recusados. O bloqueio de filhos de splits evita um defeito observado no SDK 26.9.0, descrito no [contrato Actual](actual-contract.md). Apenas `category` chega ao patch. Chave ausente/inválida ou qualquer falha de backup impede o patch. `dryRun: true` não chama a escrita nem cria exemplos reais.

O registro antes do RPC e o bloqueio de repetição não transformam a API remota em uma transação distribuída. O Actual não fornece compare-and-swap; outro cliente pode editar entre verificações. O fingerprint detecta diferenças observáveis, mas não prova ausência de uma edição externa A→B→A. Desfazer bloqueia ciclos de operações locais pela linhagem do alvo.

## Resultado, reconciliação e desfazer

`applied` exige antes/depois coerentes, fingerprint esperado, backup referenciado válido, ausência de erro, releitura e sincronização explícita. `failed_before` indica que o executor não enviou o patch. `uncertain` indica que não há prova suficiente; o worker é aposentado, nenhum patch é repetido e o estado é preservado. `simulated` registra apenas a simulação.

A conclusão, o estado por item, o feedback e a mensagem final são gravados em uma só transação. A deduplicação por operação evita duas entregas locais do mesmo resultado; consultas novas de `/operacoes <id>` usam o job novo e recebem resposta própria. Se o processo cair depois da conclusão persistida e antes de concluir o job, a recuperação fecha o job usando o resultado já existente. Reservas sem resultado viram incertas, com resposta de recuperação persistida.

`/reconciliar` faz apenas uma leitura e compara os fingerprints anterior/posterior. Operações originalmente incertas podem passar a `observed_before` ou `observed_after`; a coluna `initial_outcome` e os eventos preservam a incerteza original. Divergência mantém a operação incerta. Uma operação já aplicada não é rebaixada por uma edição posterior: a observação fica em campos separados. Observação não cria exemplo confirmado.

`/desfazer` cria outra proposta, com outro nonce e outra confirmação; não reutiliza a autorização anterior. Só atende à operação mais recente do alvo, aplicada ou originalmente incerta com `observed_after`, enquanto o fingerprint posterior permanece igual. Restaura apenas a categoria anterior, inclusive `null`. A proposta explica quando a autoria original não foi comprovada. Undo aplicado e leituras que contradizem um exemplo desativam o aprendizado daquele alvo.

## Segredos

Configuração contém referências, nunca valores secretos. O resolver aceita apenas nomes alfanuméricos com `_`/`-`, sem separadores, extensões ou caminhos. Confere arquivo regular, tamanho, link simbólico e inode/dispositivo antes de ler. Não retorna detalhes de filesystem nos erros.

Em POSIX, o arquivo deve ser acessível apenas ao dono (`0600` ou `0400`), e o processo usa `umask 077`. Em Windows, modo POSIX não representa ACLs: o operador deve restringir a pasta/arquivos à conta do processo e administradores conforme o runbook. O código não alega auditar ACLs do Windows.

Os segredos são resolvidos dentro dos adaptadores. O SDK Actual fica isolado em worker e seus streams técnicos não são retransmitidos; erros atravessam a fronteira somente como códigos da lista permitida. Tokens Telegram só são inseridos na URL fixa do próprio adaptador. Redirecionamentos HTTP são recusados.

## Conteúdo e observabilidade

Nomes de favorecido/conta e descrições são dados sem autoridade para executar ações. Snapshots e dados do Actual não vão ao modelo. Se Ollama estiver habilitado, ele recebe a pergunta atual e a data de referência para interpretar uma consulta de leitura; não se deve inserir credenciais na pergunta, e não há detector universal de segredos. `privacy.externalProviders` precisa ser `false`. Sem chaves, SDKs ou chamadas de Gemini, e-mail ou portais.

O logger registra somente evento permitido, horário, duração não negativa, integração permitida, código de erro e UUID interno validado. Não aceita objetos de erro, SQL, texto financeiro, URLs, tokens ou mensagens recebidas. A aplicação transforma erros externos em códigos antes de responder no Telegram.

Respostas de categorização, confirmações, avisos persistidos e resultados têm um único rodapé com provedor determinístico, motivo, tempo e uso de IA. O tempo é medido quando a execução atual permite; mensagens reconstruídas após reinício, avisos sem medição e erros recuperados informam `desconhecido`. A categorização usa `Uso de IA: nenhum`, sem inventar contagens de tokens. Um erro da operação aparece por código no rodapé. O resultado final já é persistido com esse rodapé e usa a mesma mensagem no retorno, preservando a deduplicação.

SQLite, snapshots, propostas, journal e outbox contêm dados financeiros e precisam de disco/volume protegido. O banco ativo não é cifrado pelo aplicativo; os [backups da escrita são cifrados](backups.md). O journal é separado do logger técnico, mas não é imutável contra um administrador da máquina.

Payloads de jobs concluídos/falhos e mensagens enviadas são removidos após 24h. Snapshots seguem `retentionDays` (padrão 90). Após essa janela, propostas expiradas/canceladas/concluídas perdem alvo, antes/depois, exibição, motivo, catálogo do destino e chave de exemplo; permanecem os nonces inutilizáveis, identidade e metadados de deduplicação/política. Operações resolvidas (`applied`, `failed_before`, `simulated`, `observed_before`, `observed_after`) perdem antes/depois ao fim da janela desde a última atualização; desfazer fica indisponível após essa minimização. Exemplos expiram pela criação, são desativados e perdem alvo/características/categoria. Eventos antigos resolvidos têm payload minimizado; códigos, horários e vínculos técnicos ficam.

Operações ainda `uncertain`, reservas em andamento e suas propostas mantêm os detalhes necessários à investigação. Dados de jobs/entregas incertas também permanecem. Não há retenção de prompts de categorização ou respostas completas de modelo: essa fase usa apenas regras, exemplos e histórico local. A retenção de arquivos de backup exige o procedimento local descrito na documentação de backups; a limpeza do SQLite não reescreve backups antigos.

## Entrega e falhas

Conclusão local e mensagens ficam numa mesma transação SQLite. Isso impede duplicidade local no replay. A API Telegram não fornece idempotência remota de `sendMessage`: um timeout depois de enviar pode significar que a mensagem chegou. Esse estado fica `uncertain` e não é reenviado automaticamente; ele nunca reexecuta o caso de uso financeiro.

Referências: [Telegram User](https://core.telegram.org/bots/api#user), [CallbackQuery](https://core.telegram.org/bots/api#callbackquery), [sendMessage](https://core.telegram.org/bots/api#sendmessage).
