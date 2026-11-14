#!/usr/bin/env bash
# Baixa a versão mais nova do GitHub e reinicia o CRM sem perder nada (dados ficam no Supabase).
set -euo pipefail
cd /opt/ionext-crm
git pull -q --ff-only
docker compose -f deploy/docker-compose.yml up -d --build
docker image prune -f >/dev/null
echo "Atualizado: $(git log -1 --format='%h %s')"
