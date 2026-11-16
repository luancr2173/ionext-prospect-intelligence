# Sobe a Central + o Motor 01 + o Motor 02 (auditoria de sites) nesta janela e abre o painel no navegador.
#   powershell -ExecutionPolicy Bypass -File .\iniciar.ps1
# Para parar: Ctrl+C nesta janela.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env_ = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path $env_)) {
  throw "Falta o .env. Rode antes: powershell -ExecutionPolicy Bypass -File .\configurar.ps1"
}

# Senha do painel (pergunta só na primeira vez)
if (-not (Select-String -Path $env_ -Pattern '^PAINEL_SENHA=.{8,}' -Quiet)) {
  do { $senha = Read-Host "Crie uma senha para o painel (mínimo 8 caracteres, sem espaços)" } while ($senha.Length -lt 8 -or $senha -match '\s')
  $linhas = @(Get-Content $env_ | Where-Object { $_ -notmatch '^PAINEL_SENHA=' }) + "PAINEL_SENHA=$senha"
  [System.IO.File]::WriteAllText($env_, ($linhas -join "`r`n") + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "Senha do painel salva no .env" -ForegroundColor Green
}

# Remove variáveis antigas desta janela para valer o que está no .env
'DATABASE_URL','CENTRAL_API_KEYS','CENTRAL_API_KEY','CENTRAL_URL','TAVILY_API_KEY','EXA_API_KEY','PAINEL_SENHA','PAGESPEED_API_KEY' |
  ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }

# Se o CRM já estiver rodando (outra janela ou um processo que ficou para trás), encerra antes de subir de novo
$porta = Get-NetTCPConnection -LocalPort 3333 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($porta) {
  $proc = Get-Process -Id $porta.OwningProcess -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -eq 'node') {
    Write-Host "O CRM já estava rodando (processo $($proc.Id)). Encerrando para iniciar de novo..." -ForegroundColor Yellow
    Stop-Process -Id $proc.Id -Force
    Start-Sleep 2
  } else {
    $nome = if ($proc) { $proc.ProcessName } else { 'desconhecido' }
    throw "A porta 3333 está ocupada por outro programa ($nome). Feche-o e rode .\iniciar.ps1 de novo."
  }
}

# Abre o painel quando a Central já estiver no ar
Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', 'Start-Sleep 12; Start-Process http://localhost:3333'

Write-Host ""
Write-Host "IONEXT Prospect Intelligence subindo (Central + Motor 01 + auditoria de sites)..." -ForegroundColor Cyan
Write-Host "O painel abre sozinho em http://localhost:3333. Para parar: Ctrl+C."
Write-Host ""
# Instala dependências novas (ex.: depois de um git pull). Se falhar, para aqui com a mensagem do pnpm.
pnpm install
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "A instalação das dependências falhou (veja a mensagem acima). Feche outras janelas do CRM e rode .\iniciar.ps1 de novo." -ForegroundColor Red
  exit 1
}
pnpm start
