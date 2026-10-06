# FinAI portátil — instalação e migração

Este pacote contém o aplicativo, não seus dados financeiros. Para levar o ambiente existente, use também o backup criptografado e sua chave. Ambos são privados e **não devem ser enviados ao GitHub**, nem mesmo a um repositório privado.

## O que é levado

O arquivo criptografado contém quatro componentes: `actual` (servidor principal inteiro), `aig` (segundo servidor FinAIG), `state` (estado persistente do bot) e `settings` (configuração e segredos).

Contas, transações, categorias, regras, orçamentos, vínculos bancários e demais registros existentes ficam nos bancos do servidor Actual. Memórias, metas, preferências, cadastro criptografado, histórico ainda retido e chaves de rollback ficam no estado/configuração do bot. O arquivo `archive-manifest.json`, dentro da cifra, registra SHA-256 de todos os arquivos e contagens das tabelas SQLite para conferir a restauração.

O backup não recupera dados que já foram excluídos, nem mensagens que nunca foram recebidas pelo bot. Não copia o estado do navegador. Modelos do Ollama são baixados novamente pelo nome salvo; não são incluídos gigabytes de pesos no GitHub. A aplicação não garante que sessões bancárias/Pluggy permaneçam válidas em outra máquina: verifique cada conexão após a migração e reconecte apenas se necessário.

O sistema financeiro e as funcionalidades de IA são os da versão implantada. Empacotar não é uma correção automática da qualidade, latência ou disponibilidade do Gemini/Ollama. O modelo local roda inicialmente em CPU; GPU exige configuração adicional de Docker/driver específica da máquina.

## Requisitos

- Docker Engine + Docker Compose v2 no Linux; ou Docker Desktop usando **containers Linux** no Windows.
- Node.js **24 LTS** no host. Os wrappers só usam a biblioteca padrão: não precisa executar `npm install` no host.
- Internet para baixar as imagens Docker e o modelo local.
- Espaço para as imagens, o modelo, os volumes e o backup. A ferramenta usa até 512 MiB para o arquivo TAR comprimido e um tmpfs de 2 GiB para verificar/restaurar; disponha de memória suficiente além daquela usada pelo modelo.
- Relógio do host sincronizado. `TZ=America/Sao_Paulo` configura o fuso, mas não corrige um relógio errado.

O servidor Actual está fixado em 26.9.0 com o digest observado na instalação de origem. O cliente usa `@actual-app/api` 26.9.0 no lockfile. O Ollama está fixado em 0.33.2. Não troque versões durante a primeira restauração.

## Baixar o código

Para baixar a versão portátil:

```bash
git clone --branch portable-migration-20261006 https://github.com/agisgithub/FinAIssistent.git
cd FinAIssistent/portable-release
```

Ou extraia o ZIP de código entregue e entre na pasta `finaig-portable`. Os comandos abaixo presumem essa pasta como diretório atual.

## Levar os seus dados — modo recomendado

Copie a **pasta do backup** para a máquina de destino, incluindo `manifest.json` e `backups/<uuid>.bin`. Leve o arquivo `chave-migracao.key` separadamente e guarde-o com acesso restrito. Sem essa chave, o backup não pode ser decifrado. O manifest externo contém apenas informações técnicas; os dados e o inventário detalhado estão cifrados.

Escolha o IP LAN da máquina de destino para acessar o dashboard pelo celular. O IP precisa ser dessa máquina; não reutilize o IP da origem sem conferir. O exemplo abaixo é ilustrativo: substitua `192.168.1.50`, caminhos e nomes conforme seu ambiente.

### Linux

```bash
bash finai.sh restore --bundle /caminho/backup-finai --key /caminho-separado/chave-migracao.key --url https://192.168.1.50:3443
bash finai.sh start
bash finai.sh status
```

### Windows PowerShell

```powershell
.\finai.ps1 restore --bundle 'D:\backup-finai' --key 'D:\chaves\chave-migracao.key' --url 'https://192.168.1.50:3443'
.\finai.ps1 start
.\finai.ps1 status
```

Se a política de execução impedir o wrapper, use `node portable/finai.mjs` no lugar de `./finai.ps1`; não é necessário alterar a política global do PowerShell.

`restore` exige uma pasta de projeto sem `.env`, recusa containers de destino em execução e recusa volumes que já tenham dados. Não apaga nem sobrescreve uma instalação existente. Em caso de falha depois de copiar parcialmente os volumes, mantenha-os para inspeção e use **um novo nome de projeto/pasta**; a ferramenta não os apaga automaticamente.

Para isolar várias instalações, defina `FINAI_PROJECT` antes do primeiro comando (somente letras minúsculas, números, `_` e `-`; começa com letra):

```bash
export FINAI_PROJECT=finaigcasa
```

```powershell
$env:FINAI_PROJECT = 'finaigcasa'
```

Use um nome que não exista no Docker dessa máquina. Não reutilize os nomes dos volumes antigos. Portas podem ser ajustadas na `.env` antes de iniciar: `FINAI_ACTUAL_PORT`, `FINAI_AIG_PORT`, `FINAI_OLLAMA_PORT`. O formulário/dashboard usa 3443 nesta versão do instalador.

### Conferir antes de ativar Telegram

1. Abra `http://localhost:5006` e entre com a senha do Actual existente.
2. Confira os nomes dos orçamentos, contas, transações recentes, categorias e regras. O Sync ID é preservado porque os arquivos do servidor são restaurados, não recriados por importação.
3. Abra `http://localhost:5007` para verificar a segunda base, se usava FinAIG.
4. Confira `finai status`. `finai start` baixa o modelo local e **não inicia o bot**.
5. A prova técnica fica em `/settings/restore-proof.json`, no volume de configuração. Antes de copiar, a ferramenta autentica a cifra, confere cada hash e todas as contagens SQLite. Depois de copiar, confere novamente os hashes dos dois servidores financeiros.

Os arquivos financeiros não são reclassificados nem reescritos pela migração. O remapeamento altera somente configurações do bot e os cadastros criptografados: URLs antigas passam a `http://actual:5006` ou `http://actual-aig:5006`; Ollama passa a `http://ollama:11434`. As identidades de usuário, chat, orçamento e permissões permanecem iguais. Links/sessões de navegador antigos são invalidados; o certificado HTTPS é gerado novamente para o novo IP. Histórico de mensagens pode ainda citar links antigos: solicite um link novo.

O canal temporário de mensagens `/piloto`, cujo prazo na origem já expirou, continua desativado. Isso não desativa o formulário de cadastro nem a conversa financeira normal.

## Troca definitiva — evitar dois bots e duas cópias divergentes

Um snapshot é uma fotografia: alterações feitas na origem depois do backup **não aparecem automaticamente na cópia**. Não opere as duas bases como se fossem a mesma. Planeje a troca final assim:

1. Pare de editar/sincronizar na origem e feche abas antigas do Actual.
2. Pare o bot antigo. Na origem atual, o comando é `docker stop --time 45 finaissistent-bot-1`. Esse comando é uma ação de troca deliberada, não é executado pela restauração.
3. Se houve alterações depois do backup entregue, gere um snapshot final antes de restaurar em um destino novo. O bot não deve voltar a consumir mensagens entre o snapshot final e a ativação do destino. Não use o comando de backup normal, que retoma automaticamente serviços antes ativos, como prova de que a origem permanece parada.
4. Só após confirmar que o bot de origem está parado, ative no destino:

```bash
bash finai.sh activate --confirm SOURCE_BOT_STOPPED
```

```powershell
.\finai.ps1 activate --confirm SOURCE_BOT_STOPPED
```

O texto de confirmação é uma declaração do operador; o instalador não verifica por SSH a máquina antiga. Não use o mesmo token em dois bots ativos. Trocar o token por um bot diferente também exige migração de identidade: esta versão conserva o token e os vínculos existentes.

5. No Telegram, teste `/status`, `/contas`, uma consulta financeira e `/dashboard`. Abra o link novo na mesma LAN/VPN.
6. Compare os dados e confirme a sincronização bancária no destino. Mantenha origem/backup preservados, mas inativos, até terminar a validação.

O certificado é autoassinado. Confira IP e certificado antes de aceitar o aviso. Quando uma URL LAN é informada, as portas de Actual/dashboard são vinculadas em `0.0.0.0`; use firewall e rede privada. Não abra essas portas na internet. `https://localhost:3443` mantém as portas vinculadas em loopback, mas links não abrem no celular remoto.

## Instalação nova, sem trazer dados

```bash
bash finai.sh setup --url https://192.168.1.50:3443
```

Ou `./finai.ps1 setup ...` no Windows. O comando constrói as imagens e abre um assistente com os segredos ocultos. Ele pede token Telegram, senha Actual, Sync ID e configurações da IA. Actual é criado vazio: você deve criar/importar um orçamento e obter seu Sync ID no navegador. Na URL interna do formulário use `http://actual:5006`. Para Ollama, no assistente use `http://host.docker.internal:11434`; a etapa final converte para o serviço interno `ollama`.

Use **um token novo e exclusivo** na instalação nova para não disputar o bot antigo. Este modo não preserva contas/dados por conta própria. Após configurar, rode `start` e ative somente quando o token não estiver sendo consumido em outra instância.

Gemini é externo e exige API key, modelo disponível e autorização de envio de dados financeiros. Na migração, essas configurações são conservadas do cadastro criptografado. Na instalação nova, configure pelo `/cadastro` e informe um modelo disponível na sua conta. Não há promessa de acesso gratuito, quota ou fallback automático. O pacote não ativa cloud sem conservar/obter o consentimento correspondente.

## Comandos de manutenção

- `help`: lista comandos.
- `status`: lista containers, inclusive o bot parado.
- `models`: baixa o modelo local salvo, sem alterar o provedor selecionado.
- `stop`: para os serviços desta instalação; não apaga volumes.
- `test`: constrói e executa a suíte de testes em container sem rede e sem volumes pessoais.
- `verify --bundle PASTA --key ARQUIVO`: autentica e verifica um backup em tmpfs, sem restaurar em volumes.
- `backup --out PASTA_NOVA --key-dir PASTA_SEPARADA`: pausa os containers antes ativos desta instalação, gera snapshot criptografado e retoma esses mesmos containers em `finally`. Gere em diretórios novos; o arquivo de chave nunca é sobrescrito.

Nunca rode `docker compose down -v`, `docker volume prune` ou `docker system prune --volumes` para atualizar este ambiente: isso pode apagar seus dados. Atualizar código e atualizar versões do Actual são operações diferentes. Faça backup e teste uma atualização antes de recriar serviços.

## GitHub e segredos

São excluídos por `.gitignore` e `.dockerignore`: `.env`, configuração real, segredos, certificados, bases SQLite, backups cifrados e chaves. O código usa lockfile; dados ficam nos volumes Docker, não no repositório. `.gitignore` não remove arquivos que já tenham sido versionados no passado. A entrega portátil é verificada separadamente antes da publicação.

Fontes: [Docker — backup e migração de volumes](https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes), [Actual — instalação Docker](https://actualbudget.org/docs/install/docker/), [Ollama — Docker](https://docs.ollama.com/docker). Implementação da cifra reutilizada: `src/backups/encrypted.mjs` (`aes-256-gcm`); recusa de sobrescrita: `portable/helper.mjs` (`DESTINATION_NOT_EMPTY`); ativação explícita: `portable/finai.mjs` (`SOURCE_BOT_STOPPED`).
