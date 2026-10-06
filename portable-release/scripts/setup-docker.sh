#!/usr/bin/env bash
set -euo pipefail

[[ "$(uname -s)" == Linux ]] || { printf '%s\n' 'Este assistente requer Linux com Bash e Docker Compose.'; exit 1; }
[[ -t 0 && -t 1 ]] || { printf '%s\n' 'Abra um terminal interativo para preencher os segredos sem eco.'; exit 1; }
command -v docker >/dev/null || { printf '%s\n' 'Docker não está disponível.'; exit 1; }
docker compose version >/dev/null
docker info --format '{{.ServerVersion}}' >/dev/null
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$repo_dir"
[[ -f Dockerfile && -f compose.yaml ]] || { printf '%s\n' 'Execute este script dentro do repositório FinAIssistent.'; exit 1; }
[[ ! -L config.json && ( ! -e config.json || -f config.json ) ]] || { printf '%s\n' 'config.json precisa ser um arquivo real, não pasta ou link.'; exit 1; }
[[ ! -L secrets && ( ! -e secrets || -d secrets ) ]] || { printf '%s\n' 'secrets precisa ser uma pasta real.'; exit 1; }
printf '%s\n' 'O assistente para somente o serviço bot durante a configuração.' 'O provisionamento usa root dentro do container para criar arquivos privados do UID 1000; a aplicação continua executando como UID 1000.' 'Actual, Ollama e seus bancos não serão alterados.'
docker compose stop bot
docker build --target runtime --tag finaissistent:setup .
if docker run --rm -it --init --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges:true --add-host host.docker.internal:host-gateway \
  --mount "type=bind,source=$repo_dir,target=/setup" finaissistent:setup node scripts/setup-docker.mjs; then
  docker compose build bot
  docker compose run --rm --no-deps bot node scripts/preflight.mjs
else
  status=$?
  printf '%s\n' 'O bot permanece parado. Confira a mensagem acima antes de tentar novamente.'
  [[ "$status" == 3 ]] && exit 0
  exit "$status"
fi
printf '%s' 'Iniciar ou recriar o bot agora? [s/N]: '
IFS= read -r start_bot || exit 0
case "${start_bot,,}" in
  s|sim) docker compose up -d --force-recreate bot; docker compose ps ;;
  *) printf '%s\n' 'Quando desejar: docker compose up -d --force-recreate bot' ;;
esac
printf '%s\n' 'No seu chat privado, teste /status e /contas; compare os valores com o Actual.' 'Logs locais: docker compose logs --tail=80 bot'
