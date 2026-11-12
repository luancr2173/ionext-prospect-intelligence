# IONEXT Prospect Intelligence

Motor de prospecção B2B da IONEXT: encontra empresas sem site ou com presença digital fraca, investiga, qualifica com evidências e entrega contexto ao agente Neo, sem envio automático.

A arquitetura completa está em [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).

## Estrutura

```
apps/central            API da Central de Oportunidades (Fastify + Postgres)
apps/motor-prospecting  Motor 01: base da Receita, verificações V2–V6, busca web gratuita, envio à Central
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
| 2 · Painel | — |
| 3 · FSQ OS Places + V1/V5 | — |
| 4 · Motor 02 (auditoria de sites) | — |
| 5 · Integração com o Neo (n8n) | — |

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

## Rodando no Windows (sem Docker)

```powershell
cd $HOME\Desktop\ionext\ionext-prospect-intelligence
git pull
pnpm install
powershell -ExecutionPolicy Bypass -File .\configurar.ps1   # uma vez: cria o .env (pergunta uma coisa por vez)
powershell -ExecutionPolicy Bypass -File .\iniciar.ps1      # abre as janelas da Central e do Motor 01
```
A Central e o Motor leem o `.env` da raiz automaticamente.

## Motor 01 — como rodar a primeira busca

1. **Baixe a base da Receita** (mensal) em [dados.gov.br › Cadastro Nacional da Pessoa Jurídica](https://dados.gov.br/dados/conjuntos-dados/cadastro-nacional-da-pessoa-juridica---cnpj) e coloque numa pasta `dados-receita/`:
   `Estabelecimentos0..9.zip`, `Empresas0..9.zip`, `Simples.zip`, `Municipios.zip`, `Cnaes.zip`.
2. **Carregue o DF** (só empresas ativas nos segmentos-alvo; o código do município e os CNAEs são conferidos nas tabelas oficiais):
   ```bash
   pnpm --filter @ionext/motor-prospecting cli carregar-receita --dir ./dados-receita --referencia 2026-10 --uf DF --municipio BRASILIA
   ```
3. **Suba a Central e o worker** (`docker compose up -d --build`, ou `pnpm central:dev` + `pnpm --filter @ionext/motor-prospecting worker`).
4. **Crie a busca de validação:**
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

## API (v1)

Todas as rotas, exceto `/health`, exigem `Authorization: Bearer <segredo>` (veja `CENTRAL_API_KEYS`).

| Método | Rota | Uso |
|---|---|---|
| POST | `/v1/buscas` | registra uma busca (UF, cidade, bairros, segmento, CNAEs, porte, quantidade) |
| GET | `/v1/buscas/:id` | status da busca e nº de empresas |
| PATCH | `/v1/buscas/:id` | o Motor 01 informa andamento (status, total, concluídas) |
| POST | `/v1/ingest/candidatas` | Motor 01 entrega candidatas com evidências; a Central deduplica, classifica e pontua |
| GET | `/v1/empresas` | lista com filtros (`uf`, `cidade`, `bairro`, `segmento`, `classificacao`, `prioridade`, `status`), ordenada por score |
| GET | `/v1/empresas/:id` | ficha completa: dados, contatos com fonte, presença, oportunidades, evidências, informações não encontradas |
| POST | `/v1/empresas/:id/evidencias-manuais` | verificação manual (perfil do Google, avaliações, atividade recente, link na bio, site encontrado) |
| POST | `/v1/opt-out` | pedido de oposição ao contato (LGPD): bloqueia e descarta oportunidades abertas |

## Regras que não se negociam

- Nenhum dado sem evidência (fonte, URL, data). Contato sem `evidencia_ref` é rejeitado pelo contrato.
- `SEM_SITE` só depois das verificações obrigatórias (V2, V3, V4, V6). Falha em qualquer uma → `PENDENTE`.
- Lead Score só conta critério com evidência; cada ponto vem com motivo.
- Merge automático só por CNPJ, identificador externo ou telefone no mesmo local. Nome parecido vai para revisão humana.
- Opt-out bloqueia a empresa em todas as entradas.
- Nenhuma mensagem é enviada sem aprovação humana.
- Sem scraping do Google Maps, Instagram ou Facebook.
