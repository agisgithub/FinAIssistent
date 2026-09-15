# Autorização e privacidade

## Fronteiras

Um orçamento, uma residência e um responsável são vinculados ao banco da aplicação. Alterar esses IDs no JSON com um banco existente falha; uma configuração equivocada não mistura históricos. O ID público do bot obtido por `getMe` também é persistido: mudar para outro bot mantendo cursor/inbox antigos falha. Rotacionar o token do mesmo bot é compatível.

Só são aceitas mensagens privadas do usuário configurado, com chat igual ao destino configurado. Bots, grupos, chats desconhecidos, mensagens encaminhadas e callbacks sem a identidade/chat esperados são recusados. Um update recusado guarda apenas ID, horário e indicador de autorização para poder avançar o cursor, sem conteúdo.

Leituras são autorizadas pelo vínculo inicial; não pedem confirmação a cada uso. Este marco não contém mutação financeira. Não existe um comando para chamar métodos arbitrários, executar código, pagar ou transferir. Quando implementadas, alterações de categoria e desfazer exigirão propostas específicas de uso único.

## Segredos

Configuração contém referências, nunca valores secretos. O resolver aceita apenas nomes alfanuméricos com `_`/`-`, sem separadores, extensões ou caminhos. Confere arquivo regular, tamanho, link simbólico e inode/dispositivo antes de ler. Não retorna detalhes de filesystem nos erros.

Em POSIX, o arquivo deve ser acessível apenas ao dono (`0600` ou `0400`), e o processo usa `umask 077`. Em Windows, modo POSIX não representa ACLs: o operador deve restringir a pasta/arquivos à conta do processo e administradores conforme o runbook. O código não alega auditar ACLs do Windows.

Os segredos são resolvidos dentro dos adaptadores. O SDK Actual fica isolado em worker e seus streams técnicos não são retransmitidos; erros atravessam a fronteira somente como códigos da lista permitida. Tokens Telegram só são inseridos na URL fixa do próprio adaptador. Redirecionamentos HTTP são recusados.

## Conteúdo e observabilidade

Nomes de favorecido/conta, descrições e texto recebido são dados sem autoridade para executar ações. Não são enviados a provedores de IA neste marco. `privacy.externalProviders` precisa ser `false`. Sem chaves, SDKs ou chamadas de Gemini, e-mail ou portais.

O logger registra somente evento permitido, horário, duração não negativa, integração permitida, código de erro e UUID interno validado. Não aceita objetos de erro, SQL, texto financeiro, URLs, tokens ou mensagens recebidas. A aplicação transforma erros externos em códigos antes de responder no Telegram.

SQLite, snapshots e outbox contêm dados financeiros e precisam de disco/volume protegido. Não estão criptografados pelo aplicativo; use criptografia do volume e backups cifrados no ambiente. Payloads de jobs concluídos/falhos e mensagens enviadas são removidos após 24h na manutenção; snapshots seguem `retentionDays` (padrão 90). Metadados de deduplicação são conservados. Dados incertos permanecem para investigação, sem repetição automática.

## Entrega e falhas

Conclusão local e mensagens ficam numa mesma transação SQLite. Isso impede duplicidade local no replay. A API Telegram não fornece idempotência remota de `sendMessage`: um timeout depois de enviar pode significar que a mensagem chegou. Esse estado fica `uncertain` e não é reenviado automaticamente; ele nunca reexecuta o caso de uso financeiro.

Referências: [Telegram User](https://core.telegram.org/bots/api#user), [CallbackQuery](https://core.telegram.org/bots/api#callbackquery), [sendMessage](https://core.telegram.org/bots/api#sendmessage).
