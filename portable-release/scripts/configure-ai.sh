#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == Linux ]] || { printf '%s\n' 'Este assistente Docker requer Linux.'; exit 1; }
[[ -t 0 && -t 1 ]] || { printf '%s\n' 'Use um terminal interativo para digitar a chave sem eco.'; exit 1; }
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$repo_dir"
[[ -f config.json && ! -L config.json ]] || { printf '%s\n' 'Configure Actual e Telegram antes; config.json precisa ser um arquivo real.'; exit 1; }
docker compose version >/dev/null
docker info --format '{{.ServerVersion}}' >/dev/null
printf '%s\n' 'O serviço bot será parado durante a configuração de IA. Actual, Telegram, volume financeiro e override de rede serão preservados.' 'O helper usa rede host Linux para consultar Ollama em 127.0.0.1; não muda a rede permanente do bot.'
docker compose stop bot
docker build --target runtime --tag finaissistent:ai-setup .
if docker run --rm -it --init --read-only --network host --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges:true --add-host host.docker.internal:host-gateway --env AI_SETUP_ROOT=/setup \
  --mount "type=bind,source=$repo_dir,target=/setup" finaissistent:ai-setup node scripts/configure-ai.mjs; then
  docker compose build bot
else
  status=$?
  printf '%s\n' 'O bot permanece parado. Revise a mensagem antes de tentar novamente.'
  [[ "$status" == 3 ]] && exit 0
  exit "$status"
fi
printf '%s' 'Iniciar ou recriar somente o bot agora? [s/N]: '
IFS= read -r start_bot || exit 0
case "${start_bot,,}" in
  s|sim) docker compose up -d --force-recreate bot; docker compose ps ;;
  *) printf '%s\n' 'Quando desejar: docker compose up -d --force-recreate bot' ;;
esac
printf '%s\n' 'No Telegram, use /ia. Não envie chaves pelo chat. A seleção Gemini pede confirmação de contexto.'
