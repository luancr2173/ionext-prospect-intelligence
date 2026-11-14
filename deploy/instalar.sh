#!/usr/bin/env bash
# Instala o IONEXT Prospect Intelligence numa VPS Ubuntu nova (rodar como root):
#   curl -fsSL https://raw.githubusercontent.com/luancr2173/ionext-prospect-intelligence/main/deploy/instalar.sh | bash
# Se o repositório for privado, clone antes e rode: bash deploy/instalar.sh
set -euo pipefail
PASTA=/opt/ionext-crm
REPO=https://github.com/luancr2173/ionext-prospect-intelligence.git

echo "==> Atualizando o sistema e instalando Docker, git e firewall"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git ufw >/dev/null
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh >/dev/null; fi

echo "==> Firewall: só SSH, HTTP e HTTPS"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

if [ ! -d "$PASTA/.git" ]; then
  echo "==> Baixando o projeto em $PASTA"
  git clone -q "$REPO" "$PASTA"
fi
cd "$PASTA"

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "==> Falta preencher o $PASTA/.env (as mesmas chaves do .env do seu PC) e acrescentar:"
  echo "      CRM_DOMINIO=crm.ionext.com.br"
  echo "      PAINEL_SENHA=uma senha com 14+ caracteres"
  echo "    Abra com:  nano $PASTA/.env   (salvar: Ctrl+O, Enter; sair: Ctrl+X)"
  echo "    Depois rode de novo:  bash $PASTA/deploy/instalar.sh"
  exit 0
fi

grep -q '^CRM_DOMINIO=.\+' .env || { echo "Falta CRM_DOMINIO no .env"; exit 1; }
grep -q '^PAINEL_SENHA=.\{14,\}' .env || { echo "PAINEL_SENHA precisa ter 14+ caracteres no .env"; exit 1; }

echo "==> Subindo (a primeira vez demora alguns minutos)"
docker compose -f deploy/docker-compose.yml up -d --build
echo
echo "Pronto. Abra https://$(grep '^CRM_DOMINIO=' .env | cut -d= -f2)  (o certificado HTTPS sai em até 1 min,"
echo "desde que o DNS do domínio já aponte para este servidor)."
echo "Logs:      docker compose -f $PASTA/deploy/docker-compose.yml logs -f crm"
echo "Atualizar: bash $PASTA/deploy/atualizar.sh"
