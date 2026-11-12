# Cria o arquivo .env (uma vez). Rode com:
#   powershell -ExecutionPolicy Bypass -File .\configurar.ps1
$ErrorActionPreference = 'Stop'
$arquivo = Join-Path $PSScriptRoot '.env'

if (Test-Path $arquivo) {
  $r = Read-Host ".env já existe. Sobrescrever? (s/N)"
  if ($r -ne 's') { Write-Host "Nada alterado."; exit 0 }
}

Write-Host ""
Write-Host "Responda uma pergunta por vez (cole e aperte Enter)." -ForegroundColor Cyan
$db     = Read-Host "1/3 Connection string do Supabase (Session pooler, já com a senha)"
if ($db -notmatch '^postgres(ql)?://') { throw "A connection string deve começar com postgresql://" }
$tavily = Read-Host "2/3 Chave do Tavily (ou só Enter para pular)"
$exa    = Read-Host "3/3 Chave da Exa (ou só Enter para pular)"

# 48 caracteres hex aleatórios (Get-Random -Count não repete itens, por isso o laço)
$segredo = -join (1..48 | ForEach-Object { '0123456789abcdef'[(Get-Random -Maximum 16)] })

$conteudo = @"
DATABASE_URL=$db
CENTRAL_API_KEYS=motor-prospecting:$segredo
CENTRAL_API_KEY=$segredo
CENTRAL_URL=http://localhost:3333
PORT=3333
TAVILY_API_KEY=$tavily
EXA_API_KEY=$exa
SCORE_MINIMO_BUSCA_WEB=45
CONCORRENCIA=4
"@

# UTF-8 sem BOM (o BOM quebraria a primeira variável)
[System.IO.File]::WriteAllText($arquivo, $conteudo, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ""
Write-Host ".env criado em $arquivo" -ForegroundColor Green
Write-Host "Próximo passo: powershell -ExecutionPolicy Bypass -File .\iniciar.ps1"
