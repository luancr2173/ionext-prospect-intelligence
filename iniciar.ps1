# Abre a Central e o worker do Motor 01 em duas janelas. Rode com:
#   powershell -ExecutionPolicy Bypass -File .\iniciar.ps1
$ErrorActionPreference = 'Stop'
$raiz = $PSScriptRoot
if (-not (Test-Path (Join-Path $raiz '.env'))) {
  throw "Falta o .env. Rode antes: powershell -ExecutionPolicy Bypass -File .\configurar.ps1"
}

Start-Process powershell -WorkingDirectory $raiz -ArgumentList '-NoExit', '-Command', 'pnpm central:dev'
Write-Host "Central abrindo... aguardando 10 s"
Start-Sleep 10
Start-Process powershell -WorkingDirectory $raiz -ArgumentList '-NoExit', '-Command', 'pnpm --filter @ionext/motor-prospecting worker'
Write-Host ""
Write-Host "Pronto: duas janelas abertas (Central e Motor 01). Deixe as duas abertas." -ForegroundColor Green
Write-Host "Para criar uma busca, nesta janela:"
Write-Host '  pnpm --filter @ionext/motor-prospecting cli buscar --segmento clinica_odontologica --uf DF --cidade Brasilia --bairros "Asa Norte,Taguatinga,Aguas Claras" --quantidade 100'
