# IONEXT Prospect Intelligence

Motor de prospecção B2B da IONEXT: encontra empresas sem site ou com presença digital fraca, investiga, qualifica com evidências e entrega contexto ao agente Neo, sem envio automático.

A arquitetura completa está em [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).

## Estrutura

```
apps/central            API da Central de Oportunidades (Fastify + Postgres)
apps/motor-prospecting  Motor 01: base da Receita, verificações V2–V6, busca web gratuita, envio à Central
apps/motor-audit        Motor 02: auditoria de sites (PageSpeed Insights + leitura do HTML), diagnóstico B/C/D
packages/dominio        Regras puras: CNPJ alfanumérico, normalização, classificação de presença, Lead Score
packages/contratos      Contratos v1 (Zod) entre motores, Central e Neo
supabase/migrations     Schema do banco (fonte única, aplicado no Supabase e nos testes)
docs/                   Arquitetura e decisões
```

## Status

| Fase | Situação |
|---|---|
| 0 · Fundação (schema, Central, dedup, score, opt-out, testes) | ✅ concluída |
| 1 · Motor 01 MVP (ETL Receita + OSM + verificações V2–V6 + busca web gratuita + varredura pelo Claude) | ✅ concluída (falta a primeira execução real) |
| 2 · Painel (visão geral, funil, ficha, resultados, exportação) | ✅ concluída |
| 3 · FSQ OS Places + V1/V5 | — |
| 4 · Motor 02 (auditoria de sites) | ✅ v0.1: PageSpeed + HTML, sem navegador |
| 5 · Integração com o Neo (n8n) | ✅ prospecção e atendimento (só oportunidade A) |

## Rodando localmente

Requisitos: Node 20+, pnpm 10, Postgres 16 com PostGIS (ou a connection string do Supabase).

```bash
pnpm install
cp .env.example .env        # preencha DATABASE_URL e CENTRAL_API_KEYS
pnpm central:dev            # http://localhost:3333/health
```

### Testes

As regras de domínio rodam sem banco. Os testes de integração precisam de um Postgres **descartável** (as tabelas são truncadas):

```bash
docker run -d --name pi-test -p 54329:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgis/postgis:16-3.4
psql -h localhost -p 54329 -U postgres -c "drop extension if exists postgis_tiger_geocoder, postgis_topology, fuzzystrmatch, postgis cascade"
psql -h localhost -p 54329 -U postgres -c "create schema extensions"
psql -h localhost -p 54329 -U postgres -c "alter database postgres set search_path = public, extensions"
for f in supabase/migrations/*.sql; do psql -h localhost -p 54329 -U postgres -v ON_ERROR_STOP=1 -f "$f"; done
TEST_DATABASE_URL=postgres://postgres@localhost:54329/postgres pnpm test
```

Nunca aponte `TEST_DATABASE_URL` para o Supabase de produção.

## Como usar (Windows)

Primeira vez:
```powershell
cd $HOME\Desktop\ionext\ionext-prospect-intelligence
git pull
powershell -ExecutionPolicy Bypass -File .\configurar.ps1   # cria o .env (banco, Tavily, senha do painel)
```

Todo dia:
```powershell
powershell -ExecutionPolicy Bypass -File .\iniciar.ps1      # sobe Central + Motor 01 e abre o painel
```

O painel abre em **http://localhost:3333** (prints com dados fictícios em `docs/painel-*.png`). Por ele você:
- cria buscas (segmento, bairros, quantidade) e acompanha o progresso;
- reprocessa uma busca depois de uma melhoria nas regras (a busca web usa o cache);
- filtra empresas por presença digital, prioridade e status;
- abre a ficha com verificações V1–V6, Lead Score explicado, contatos, fontes e evidências;
- registra verificação manual (perfil do Google, avaliações, link na bio, site encontrado);
- aprova para o Neo, descarta ou registra "não contatar" (LGPD).

O topo mostra se o Motor 01 está rodando, a cota gratuita usada no mês e a fila do Claude.
Para parar tudo: `Ctrl+C` na janela do `iniciar.ps1`.

A Central escuta só em `127.0.0.1` (o painel fica restrito ao seu computador). Num servidor, defina `HOST=0.0.0.0`,
coloque HTTPS na frente e `COOKIE_SEGURO=1`.

## Motor 01 — como rodar a primeira busca

1. **Baixe a base da Receita** (mensal) em [dados.gov.br › Cadastro Nacional da Pessoa Jurídica](https://dados.gov.br/dados/conjuntos-dados/cadastro-nacional-da-pessoa-juridica---cnpj) e coloque numa pasta `dados-receita/`:
   `Estabelecimentos0..9.zip`, `Empresas0..9.zip`, `Simples.zip`, `Municipios.zip`, `Cnaes.zip`.
2. **Carregue o DF** (só empresas ativas nos segmentos-alvo; o código do município e os CNAEs são conferidos nas tabelas oficiais):
   ```bash
   pnpm --filter @ionext/motor-prospecting cli carregar-receita --dir ./dados-receita --referencia 2026-10 --uf DF --municipio BRASILIA
   ```
3. **Suba tudo** com `iniciar.ps1` (ou `pnpm start`, ou `docker compose up -d --build`).
4. **Crie a busca** pelo painel, ou pela linha de comando:
   ```bash
   pnpm --filter @ionext/motor-prospecting cli buscar --segmento clinica_odontologica --uf DF --cidade Brasilia \
     --bairros "Asa Norte,Taguatinga,Aguas Claras" --quantidade 300
   ```
5. Acompanhe com `cli status` e pela API (`GET /v1/empresas?segmento=clinica_odontologica`).

Segmentos disponíveis: `clinica_odontologica`, `clinica_medica`, `academia`, `restaurante`, `beleza`, `oficina_mecanica`, `construcao_civil`, `imobiliaria`, `contabilidade` (`packages/dominio/src/segmentos.ts`).

### Verificações (sem nenhuma API paga)

| | Fonte | O que faz |
|---|---|---|
| V2 | OpenStreetMap (Overpass) | 1 consulta por segmento/UF a cada 7 dias; casa por telefone ou nome + local; usa tag `website` e redes |
| V3 | Domínio do e-mail da Receita | DNS + HTTP; domínio declarado pela empresa conta como dela |
| V4 | Domínios gerados do nome | DNS + HTTP + **prova de titularidade** (CNPJ, telefone ou nome + local na página). Só o nome → `inconclusivo` → PENDENTE |
| V5 | Busca web | Tavily → Exa (cotas grátis, contadas para nunca passar) → fila do Claude. Só para leads com score estimado ≥ `SCORE_MINIMO_BUSCA_WEB` e sem site achado |
| V6 | Redes | Instagram/Facebook/WhatsApp/Linktree vindos do OSM e da busca web (perfil precisa ter nome compatível) |

**Varredura pelo Claude:** a tarefa agendada "Varredura web IONEXT" roda todo dia às 20h37 (Brasília), pega até 20 itens de `motor.fila_busca_web`, pesquisa e grava só as URLs encontradas. O worker consome esses resultados a cada 15 min, **verifica cada link** e reenvia a empresa à Central.

Contatos de MEI vindos da Receita entram com `publico_comercial = false` (podem ser pessoais, LGPD).

## Motor 02 — auditoria de sites

Sobe junto com o resto (`pnpm start` / `iniciar.ps1`). Pega da Central as empresas com site, lê até 8 páginas internas
(links, formulários, WhatsApp, telefone clicável, título/descrição, rodapé, sitemap, conteúdo sem HTTPS) e roda o
PageSpeed Insights no celular e no computador. Classe por regra fixa (`packages/dominio/src/auditoria.ts`):
**B** site fora do ar ou 2+ falhas graves · **C** 1 grave ou 3+ moderados · **D** nenhum dos anteriores.

- Sem `PAGESPEED_API_KEY` funciona, mas o Google limita: a auditoria tenta de novo (15 min, 30 min, 1 h…) e, na
  4ª tentativa, audita só pelo HTML. Com a chave (gratuita) fica rápido.
- Auditar um site sem gravar nada: `pnpm --filter @ionext/motor-audit cli auditar --url https://site.com.br`
- O Neo ainda só aborda oportunidades **A** (sem site); B/C/D aparecem no CRM com o relatório para contato manual.

## API (v1)

Todas as rotas `/v1`, exceto `/health`, exigem `Authorization: Bearer <segredo>` (veja `CENTRAL_API_KEYS`) ou a sessão do painel (cookie httpOnly; escritas exigem também o cabeçalho `x-painel: 1`).

| Método | Rota | Uso |
|---|---|---|
| POST | `/v1/buscas` | registra uma busca (UF, cidade, bairros, segmento, CNAEs, porte, quantidade) |
| GET | `/v1/buscas?status=` | lista buscas (o Motor 01 lê as `planejada`/`reprocessar` a cada 20 s) |
| GET | `/v1/buscas/:id` | status da busca e nº de empresas |
| POST | `/v1/buscas/:id/reprocessar` | pede ao Motor 01 para verificar de novo |
| PATCH | `/v1/buscas/:id` | o Motor 01 informa andamento (status, total, concluídas) |
| POST | `/v1/ingest/candidatas` | Motor 01 entrega candidatas com evidências; a Central deduplica, classifica e pontua |
| GET | `/v1/empresas` | lista com filtros (`uf`, `cidade`, `bairro`, `segmento`, `classificacao`, `prioridade`, `status`), ordenada por score |
| GET | `/v1/empresas/:id` | ficha completa: dados, contatos com fonte, presença, oportunidades, evidências, informações não encontradas |
| POST | `/v1/empresas/:id/evidencias-manuais` | verificação manual (perfil do Google, avaliações, atividade recente, link na bio, site encontrado) |
| PATCH | `/v1/oportunidades/:id` | muda o status comercial (aprovar para o Neo, descartar…) |
| GET | `/v1/painel/resumo` | números da visão geral + estado dos motores |
| PUT | `/v1/motores/:nome` | sinal de vida e métricas de um motor |
| POST | `/v1/opt-out` | pedido de oposição ao contato (LGPD): bloqueia e descarta oportunidades abertas |
| POST | `/v1/auditorias/reservar` | Motor 02 pede trabalho (a Central põe na fila os sites ainda não auditados ou auditados há 90+ dias) |
| POST | `/v1/auditorias` | Motor 02 entrega o `DiagnosticoSite`; a Central recalcula a classe, grava evidências e cria a oportunidade B/C/D |
| POST | `/v1/auditorias/:empresa_id/falha` | falha temporária: volta para a fila com espera crescente |
| POST | `/v1/empresas/:id/auditar` | "Auditar de novo" no painel (fura a fila) |

## Regras que não se negociam

- Nenhum dado sem evidência (fonte, URL, data). Contato sem `evidencia_ref` é rejeitado pelo contrato.
- `SEM_SITE` só depois das verificações obrigatórias (V2, V3, V4, V6). Falha em qualquer uma → `PENDENTE`.
- Lead Score só conta critério com evidência; cada ponto vem com motivo.
- Merge automático só por CNPJ, identificador externo ou telefone no mesmo local. Nome parecido vai para revisão humana.
- Opt-out bloqueia a empresa em todas as entradas.
- Nenhuma mensagem é enviada sem aprovação humana.
- Sem scraping do Google Maps, Instagram ou Facebook.

## CRM online (VPS)

Painel + Motor 01 numa VPS Ubuntu com HTTPS automático (Caddy) em `crm.ionext.com.br`:

1. DNS: registro `A` de `crm` apontando para o IP da VPS.
2. Na VPS, como root: `curl -fsSL https://raw.githubusercontent.com/luancr2173/ionext-prospect-intelligence/main/deploy/instalar.sh | sudo bash`
3. Preencha `/opt/ionext-crm/.env` (mesmas chaves do PC + `CRM_DOMINIO` e `PAINEL_SENHA` com 14+ caracteres) e rode `bash /opt/ionext-crm/deploy/instalar.sh` de novo.
4. Atualizar depois: `bash /opt/ionext-crm/deploy/atualizar.sh`.

Online, o login bloqueia o IP por 15 min após 5 senhas erradas e o cookie só trafega por HTTPS. Os dados ficam no Supabase; a VPS não guarda nada além do `.env`.
