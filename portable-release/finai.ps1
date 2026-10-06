$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Instale Node.js 24 LTS e Docker Desktop (containers Linux).' }
    & node portable/finai.mjs @args
    if ($LASTEXITCODE -ne 0) { throw "FinAI encerrou com código $LASTEXITCODE." }
} finally { Pop-Location }
