#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
command -v node >/dev/null || { printf '%s\n' 'Instale Node.js 24 LTS e Docker com Compose antes de continuar.'; exit 1; }
exec node portable/finai.mjs "$@"
