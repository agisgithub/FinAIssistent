# Instalar e testar o FinAIssistent no Docker

Este guia usa Bash no servidor Linux, com o projeto em `~/FinAIssistent` e Docker Engine convencional. Actual e Ollama já podem estar instalados no mesmo servidor; o Compose deste projeto sobe somente o bot. Não é necessário instalar Node.js no host. Em Docker rootless ou com remapeamento de usuários, o UID do host pode ser diferente: ajuste o dono conforme o [mapeamento de UID/GID do Docker](https://docs.docker.com/engine/security/rootless/uid-gid-mapping/) e use o pré-teste dentro do container como prova de acesso.

## O que significa o erro apresentado

O build terminou, mas o processo encerrou com `startup_failed` e `CONFIG_INVALID`. Isso indica falha na configuração ou no vínculo com um estado existente. O log antigo não identificava qual campo falhou; sozinho, ele não comprova que seja senha errada.

Um caso coberto pela correção é `config.json` ausente: o bind mount antigo podia criar uma **pasta** com esse nome. O Compose atualizado exige a origem existente, e o pré-teste informa arquivo/campo e motivo sem mostrar valores. A criação automática de pastas pela sintaxe curta é comportamento documentado do [Docker Compose](https://docs.docker.com/reference/compose-file/services/#volumes).

## 1. Parar as tentativas e atualizar

Execute no mesmo diretório e com o mesmo projeto Compose usados na instalação anterior, preservando os volumes:

```bash
cd ~/FinAIssistent
docker compose stop bot
git status --short
git pull --ff-only origin main
docker compose version
```

Se o Git apontar conflito ou recusar o pull por alterações locais, resolva esse caso antes de continuar. `config.json` e `secrets/` são ignorados pelo Git. Os comandos deste guia não removem volumes; **não use `docker compose down -v` nem `docker volume prune`** para corrigir configuração. Se já houve uso do bot, faça o [backup operacional](runbook.md#backup-e-restauração) com ele parado antes da atualização.

Para uma primeira instalação em outro servidor, use `git clone https://github.com/agisgithub/FinAIssistent.git` e entre na pasta criada. O host precisa de Docker Engine com Compose v2, Git, Bash, `sudo` e OpenSSL. A [instalação oficial do Docker Engine](https://docs.docker.com/engine/install/) varia conforme a distribuição; no servidor do log o Docker já está funcionando.

## 2. Garantir que a configuração seja um arquivo

Confira o tipo, sem imprimir o conteúdo:

```bash
ls -ld -- config.json
```

Se aparecer `No such file`, crie o arquivo a partir do exemplo Docker. Se começar com `d`, é uma pasta: execute apenas `sudo rmdir -- config.json`. Esse comando remove somente uma pasta vazia; se recusar, preserve o conteúdo e verifique o que está nela. Se for um link simbólico, resolva sua origem antes de continuar.

O bloco abaixo copia o exemplo **somente quando o caminho não existe** e mantém um arquivo já preenchido:

```bash
if [ ! -e config.json ] && [ ! -L config.json ]; then
  cp -- config.docker.example.json config.json
fi
test -f config.json && test ! -L config.json
```

O último comando precisa terminar com sucesso. Para conferir, execute `echo $?`: o resultado deve ser `0`. Depois ajuste o acesso ao UID/GID 1000 usado pela imagem:

```bash
sudo chown 1000:1000 -- config.json
sudo chmod 0600 -- config.json
sudo nano config.json
```

Use `sudo vi config.json` se o host não tiver Nano. No editor, preserve o JSON válido: aspas duplas, sem comentários e sem vírgula depois do último campo. Ajuste:

| Campo | Valor necessário |
| --- | --- |
| `dataDir` | `/data` |
| `secretDir` | `/run/secrets` |
| `telegram.userId` e `telegram.chatId` | Seu ID numérico no chat **privado**; os dois devem ser iguais. O passo 5 obtém esses números |
| `telegram.tokenRef` | `telegram-token`, nome do arquivo, sem o token |
| `actual.serverURL` | Endereço do Actual alcançável pelo container; veja o passo 3 |
| `actual.budgetId` | **Sync ID** do orçamento, sem o texto `REPLACE_WITH_SYNC_ID` |
| `actual.passwordRef` | `actual-password`, nome do arquivo, sem a senha |
| `actual.encryptionPasswordRef` | `null` se o orçamento não usa criptografia ponta a ponta; caso use, `actual-encryption-password` |
| `backup.keyRef` | `null` para começar; veja o passo 8 antes de permitir escrita real |
| `dryRun` | `true` durante a validação inicial |
| `privacy.externalProviders` | `false` |
| `ollama.enabled` | `false` durante a validação inicial |

**Quais chaves são necessárias?** Para começar: token de um bot Telegram e senha de acesso ao servidor Actual. O Sync ID e seus IDs Telegram são identificadores, não chaves de API. No Actual, abra o orçamento → **Settings/Configurações → Show advanced settings/Mostrar configurações avançadas → Sync ID**. A senha de login do servidor e a senha de criptografia do orçamento são credenciais distintas. O SDK usa esses dados conforme a [documentação oficial do Actual](https://actualbudget.org/docs/api/#connecting-to-a-remote-server).

Gemini e OpenAI não estão integrados neste MVP; não há chave deles para preencher. O uso básico funciona sem Ollama. Fontes locais: [exemplo Docker](../config.docker.example.json), [validação](../src/config.mjs) e [interpretação opcional](routing.md).

## 3. Ligar o bot ao Actual que já existe

Mesmo no mesmo servidor físico, `localhost` dentro do bot aponta para o próprio container. Escolha uma das opções:

| Onde o Actual atende | `actual.serverURL` |
| --- | --- |
| Endereço HTTPS já utilizado no navegador e acessível pelo container | O mesmo endereço base, por exemplo `https://actual.seudominio.com` |
| Porta publicada no IP da rede local do servidor | Por exemplo `http://192.168.1.50:5006`, usando seu IP e sua porta reais |
| Outro container na mesma rede Docker do bot | Nome/alias real do serviço e porta interna, por exemplo `http://actual:5006` |
| Serviço no host acessível pela interface bridge do Docker | `http://host.docker.internal:5006`, usando o alias já incluído no Compose |

O nome `actual` só funciona se existir como nome/alias em uma rede compartilhada. Este projeto não cria um serviço chamado `actual`. A descoberta por serviço e o uso de redes externas seguem as [regras de rede do Compose](https://docs.docker.com/compose/how-tos/networking/).

### Opção para serviço no host Linux

O `compose.yaml` atualizado já inclui:

```yaml
services:
  bot:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

Esse alias aponta para o host, mas não abre a porta nem muda a interface em que o Actual escuta. Se o serviço estiver acessível apenas por `127.0.0.1` no host, o alias sozinho não basta. Prefira um endereço HTTPS/LAN já alcançável ou uma rede compartilhada do Docker; não exponha a porta à internet para resolver a conexão. O [Docker documenta o mapeamento `host-gateway` no Linux](https://docs.docker.com/compose/how-tos/networking/#custom-dns-with-extra_hosts).

### Opção para outro container

Consulte as redes do container Actual, substituindo o nome no comando. O vínculo abaixo usa uma [rede externa já existente](https://docs.docker.com/reference/compose-file/networks/#external):

```bash
docker inspect NOME_DO_CONTAINER_ACTUAL --format '{{json .NetworkSettings.Networks}}'
```

Escolha uma rede existente apropriada, confira o nome/alias do Actual nela e acrescente ao `compose.override.yaml`:

```yaml
services:
  bot:
    networks:
      - default
      - actual_shared
networks:
  actual_shared:
    external: true
    name: NOME_REAL_DA_REDE_EXISTENTE
```

Substitua `NOME_REAL_DA_REDE_EXISTENTE`; mantenha no JSON o nome/alias real do Actual e a porta **interna** dele. Ao atualizar o projeto Actual, preserve essa rede ou ajuste a associação. Se já usa `compose.override.yaml`, reúna as alterações no mesmo mapa `services`/`networks`, sem duplicar chaves YAML.

## 4. Gravar token e senhas em arquivos privados

Crie um bot exclusivo conversando com o [@BotFather oficial](https://t.me/BotFather), comando `/newbot`, e guarde o token que ele fornecer. Depois abra a conversa privada com seu novo bot e envie `/start`. Esse procedimento é descrito no [tutorial oficial do Telegram](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).

O diretório e os arquivos devem pertencer ao UID 1000 do container. O `sudo` abaixo é usado para provisionar esse dono mesmo quando o usuário do host tem outro UID. Se `secrets` for um link ou um arquivo, corrija o caminho antes; ele deve ser uma pasta real.

```bash
sudo install -d -o 1000 -g 1000 -m 0700 -- secrets
```

Cole esta função no Bash. Ela pede o valor sem exibi-lo nem colocá-lo no histórico e **recusa sobrescrever um segredo existente**:

```bash
criar_segredo() {
  case "$1" in
    telegram-token|actual-password|actual-encryption-password) ;;
    *) printf '%s\n' 'Nome de segredo inválido.'; return 1 ;;
  esac
  sudo bash -c '
    set -e
    set +x
    umask 077
    [[ -d ./secrets && ! -L ./secrets ]] || { printf "%s\n" "secrets precisa ser uma pasta real."; exit 1; }
    arquivo="./secrets/$1"
    if [[ -e "$arquivo" || -L "$arquivo" ]]; then
      printf "%s\n" "Arquivo já existe; preservado."
      exit 1
    fi
    IFS= read -r -s -p "Valor de $1: " segredo
    printf "\n"
    [[ -n "$segredo" ]] || { printf "%s\n" "Valor vazio; nada gravado."; exit 1; }
    set -o noclobber
    printf "%s\n" "$segredo" > "$arquivo"
    unset segredo
    chown 1000:1000 -- "$arquivo"
    chmod 0600 -- "$arquivo"
  ' -- "$1"
}
criar_segredo telegram-token
criar_segredo actual-password
```

Se o orçamento usa criptografia ponta a ponta, execute também `criar_segredo actual-encryption-password` e ajuste sua referência no JSON. Se não usa, mantenha `encryptionPasswordRef: null`.

Para arquivos que já existiam, confira dono e modo sem imprimir seu conteúdo:

```bash
sudo stat -c '%a %u:%g %n' -- secrets secrets/telegram-token secrets/actual-password
```

Resultado esperado: pasta `700 1000:1000`; arquivos `600 1000:1000` ou `400 1000:1000`. Corrija somente os arquivos reais necessários com `sudo chown 1000:1000 -- secrets/telegram-token secrets/actual-password` e `sudo chmod 0600 -- secrets/telegram-token secrets/actual-password`. Inclua o arquivo de criptografia se configurado. Uma referência é sempre o nome do arquivo; não use `cat` para colar o segredo no JSON.

## 5. Conferir o token e obter seus IDs Telegram

Construa a imagem atualizada; mantenha o bot parado:

```bash
docker compose build bot
docker compose run --rm --no-deps bot node scripts/telegram-info.mjs
```

O utilitário usa o arquivo `/run/secrets/telegram-token`, verifica o bot/webhook e consulta as mensagens pendentes. Mostra apenas os IDs necessários e códigos operacionais, sem conteúdo das mensagens, nomes, token ou URL com credencial. Ele não confirma mensagens recebidas nem remove webhook. O token continua fora da linha de comando e do histórico. O comportamento de leitura sem avanço de `offset` vem de [`getUpdates`](https://core.telegram.org/bots/api#getupdates).

Copie **seu `userId` e o `chatId` privado correspondente** para `config.json`, ambos como números sem aspas. Não use o ID do bot nem seu número de telefone. Se não houver chat privado, envie `/start` pelo seu Telegram e execute o utilitário novamente. Se houver vários pares, identifique o seu antes de autorizar a aplicação; não escolha uma pessoa apenas por ser o primeiro resultado.

Se aparecer `updatesAtLimit: true` com motivo `first_100_updates_only_do_not_assume_owner`, a ferramenta examinou apenas as primeiras 100 mensagens pendentes. Ela não percorre outras páginas nem avança o cursor para procurar você. A ausência do seu ID nesse caso não comprova ausência do seu `/start`; use um bot exclusivo cuja conversa você possa identificar antes de preencher os IDs.

Se houver `TELEGRAM_WEBHOOK_ACTIVE`, esse bot já está configurado para outro receptor. Use um bot exclusivo ou revise conscientemente essa integração; o utilitário não apaga o webhook. Não deixe outra aplicação fazendo polling do mesmo bot durante a instalação. As duas formas de recebimento são exclusivas conforme a [Bot API](https://core.telegram.org/bots/api#getwebhookinfo).

## 6. Testar configuração e código antes de subir

Com os campos e segredos preenchidos:

```bash
docker compose config --quiet
docker compose run --rm --no-deps bot node scripts/preflight.mjs
```

O pré-teste é local: valida configuração, leitura/permissões dos segredos e escrita nos diretórios de dados. Não conecta ao Actual/Telegram, não altera seu orçamento e não comprova que a senha foi aceita pelo servidor. Corrija o campo/motivo apontado e repita até o comando terminar com código `0`. A verificação de escrita cria e remove um arquivo temporário próprio; não apaga o SQLite.

O resultado final esperado é `{"event":"preflight_ok","network":"not_checked"}`. Exemplos de diagnóstico:

| Campo / motivo | Correção |
| --- | --- |
| `configFile` / `file_missing`, `expected_file` ou `invalid_json` | Corrigir existência, tipo ou sintaxe de `config.json` |
| `actual.budgetId` / `replace_placeholder` | Preencher o Sync ID real |
| `telegram.chatId` / `private_chat_must_match_user` | Usar os IDs correspondentes do seu chat privado |
| Segredo / `secret_unavailable` ou `secret_permissions` | Conferir referência, arquivo, dono e modos do passo 4 |
| Diretório / `directory_missing` ou `directory_not_writable` | Conferir os caminhos `/data`, `/run/secrets`, mounts e acesso do UID do container |
| `backup.keyRef` / `backup_key_required_for_writes` | Manter `dryRun: true` ou provisionar a chave do passo 8 |

Agora execute a suíte sintética isolada:

```bash
docker compose -f compose.test.yaml run --build --rm tests
```

O build baixa a imagem e as dependências; **a execução dos testes usa `network_mode: none`**, dados sintéticos e não monta seus segredos/volumes do bot. O resumo precisa indicar nenhuma falha; no Linux, nenhum teste deve ser ignorado. A quantidade pode crescer nas atualizações. Fontes: [Compose de testes](../compose.test.yaml) e [Dockerfile](../Dockerfile).

## 7. Subir e testar de verdade pelo Telegram

```bash
docker compose up -d bot
docker compose ps
docker compose logs --tail=80 bot
```

O log deve registrar `started`, sem sequência de `startup_failed`. Aguarde o healthcheck inicial e repita `docker compose ps`; o estado esperado é `healthy`. Esse teste mede o heartbeat local, não a conexão com o Actual. `Ctrl+C` encerra apenas a visualização caso use `docker compose logs -f bot`.

No chat privado autorizado, envie um comando por vez:

| Teste | O que conferir |
| --- | --- |
| `/status` | O bot responde; confira modo de simulação e estado local |
| `/contas` | Uma leitura nova do Actual funciona; compare uma conta com o Actual na mesma data |
| `/resumo` | Confira período, contas incluídas e totais; uma resposta marcada desatualizada não comprova conexão atual |
| `/orcamento` | Compare o mês/envelopes no Actual |
| `/relatorio` | Receba o relatório manual sem ativar agenda automática |
| `/preferencias` | Diário e alertas continuam desligados até sua escolha |

Para a primeira conferência, escolha no Actual um período pequeno com lançamentos conhecidos e use `/resumo YYYY-MM-DD YYYY-MM-DD` com essas datas. Considere o escopo mostrado: transferências entre contas e pais de splits não são contados novamente como despesas. Os valores esperados vêm do seu orçamento, não do fixture do README.

**Categorização em simulação:** mantenha `dryRun: true`, copie um lançamento simples de `/sem_categoria` e um destino de `/categorias`, envie `/categorizar ID_LANCAMENTO ID_CATEGORIA`, confira a proposta e confirme pelo botão. `/operacoes` deve mostrar a simulação; confira no Actual que a categoria permaneceu igual. A proposta consumida não executa novamente; uma escrita real posterior exige nova proposta. Veja [autorização](authorization.md).

Se o bot responder `/status`, mas `/contas` falhar, a inicialização já avançou: revise URL/rede do passo 3, senha do servidor, Sync ID e eventual senha de criptografia. Consulte os [códigos operacionais](runbook.md#códigos-operacionais). A saúde local não é prova de credencial Actual válida.

## 8. Habilitar funções opcionais, depois da conferência

### Escrita real de categoria e chave de backup

Somente é necessário configurar a chave abaixo se for habilitar `dryRun: false`. Ela cifra os backups locais do FinAIssistent; **não é a senha de criptografia do Actual**. O bloco gera 32 bytes aleatórios em hexadecimal sem imprimir o valor e preserva uma chave já existente:

```bash
sudo bash -c '
  set -e
  set +x
  umask 077
  [[ -d ./secrets && ! -L ./secrets ]] || { printf "%s\n" "secrets precisa ser uma pasta real."; exit 1; }
  arquivo="./secrets/backup-key"
  if [[ -e "$arquivo" || -L "$arquivo" ]]; then
    printf "%s\n" "Chave já existe; preservada."
    exit 0
  fi
  set -o noclobber
  openssl rand -hex 32 > "$arquivo"
  chown 1000:1000 -- "$arquivo"
  chmod 0600 -- "$arquivo"
'
```

Guarde uma cópia protegida dessa chave fora do volume de dados. Não a gere novamente por cima: backups anteriores precisam da chave original. Edite `config.json`: `backup.keyRef` recebe `backup-key`; `dryRun` recebe `false`. Então execute:

```bash
docker compose stop bot
docker compose run --rm --no-deps bot node scripts/preflight.mjs
docker compose up -d bot
```

Se o pré-teste falhar, corrija antes do `up`. Faça uma nova proposta em um lançamento simples, confirme somente o destino desejado, confira no Actual e consulte `/operacoes`. Para testar recuperação, `/desfazer ID_OPERACAO` prepara outra proposta que também exige confirmação. Procedimentos e limites estão em [backups](backups.md) e [autorização](authorization.md).

### Relatórios e recorrências

`/relatorio` é o teste imediato. Para testar entrega agendada, configure pelo chat um horário futuro próximo no fuso desejado, inclua o dia de hoje e ative explicitamente `/preferencias relatorio ativar`. Confira a entrega; desative com `/preferencias relatorio desativar` se era apenas uma prova. A gramática está em [agenda e preferências](scheduling.md).

Para contas recorrentes, use o [guia de cadastro](recurrences.md#começar-pelo-telegram): crie/ confirme uma unidade real, confira uma recorrência com seus IDs e consulte `/proximos_vencimentos`. Só habilite `lembretes=sim` se desejar os avisos. Um teste de horário pode usar `dias=0` com vencimento hoje e horário ainda futuro, sempre revendo a proposta antes de confirmar. Use um cadastro apropriado para a prova e pause-o ao terminar se não quiser mantê-lo.

**`dryRun` protege a escrita de categoria no Actual; unidades, recorrências, preferências e declarações de pagamento são alterações locais reais após confirmação.** Use `/pago` somente para um pagamento que você deseja registrar; compatibilidade de lançamento não marca uma conta paga automaticamente.

### Ollama já instalado no mesmo servidor

Ollama é opcional e não exige chave Gemini/OpenAI neste projeto. Depois que consultas explícitas funcionarem, siga [interpretação local e privacidade](routing.md#configuração). Confira o nome exato de um modelo local, desative recursos cloud no servidor e então configure `ollama.enabled`, `model` e `localOnlyConfirmed`.

No Docker, `http://127.0.0.1:11434` alcança o próprio bot. Para o Ollama no host, use `http://host.docker.internal:11434` com o alias e a interface de escuta conferidos no passo 3; um IP literal da LAN requer `allowPrivateAddress: true`. O validador desta aplicação aceita somente os hosts locais/privados descritos em [routing.md](routing.md), não qualquer nome de serviço Docker. Não abra Ollama à internet. Reinicie o bot após ajustar o JSON e teste uma pergunta de leitura; cálculos financeiros continuam no código.

## Atualizações e diagnóstico posterior

Mantenha `config.json`, `secrets/`, o projeto Compose e os volumes existentes. Para atualizar: pare o bot, faça backup do estado, `git pull --ff-only origin main`, `docker compose build bot`, pré-teste, testes e `docker compose up -d bot`.

Se precisar relatar outra falha, compartilhe apenas os códigos/campos/motivos dos diagnósticos e o resultado dos testes, sem token, senha, chave, `config.json` inteiro ou respostas com dados financeiros. O [runbook](runbook.md) explica recuperação, versões incompatíveis e estados incertos.
