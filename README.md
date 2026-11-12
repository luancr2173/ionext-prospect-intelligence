# IONEXT Prospect Intelligence

Motor de prospecção B2B da IONEXT: encontra empresas sem site ou com presença digital fraca, investiga, qualifica com evidências e entrega contexto ao agente Neo, sem envio automático.

A arquitetura completa está em [`docs/ARQUITETURA.md`](docs/ARQUITETURA.md).

## Estrutura

```
apps/central            API da Central de Oportunidades (Fastify + Postgres)
packages/dominio        Regras puras: CNPJ alfanumérico, normalização, classificação de presença, Lead Score
packages/contratos      Contratos v1 (Zod) entre motores, Central e Neo
supabase/migrations     Schema do banco (fonte única, aplicado no Supabase e nos testes)
docs/                   Arquitetura e decisões
```

## Status

| Fase | Situação |
|---|---|
| 0 · Fundação (schema, Central, dedup, score, opt-out, testes) | ✅ concluída |
| 1 · Motor 01 MVP (ETL Receita + Overpass + verificações V2/V3/V4/V6) | próxima |
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
psql -h localhost -p 54329 -U postgres -f supabase/migrations/20261112000000_central_schema.sql
TEST_DATABASE_URL=postgres://postgres@localhost:54329/postgres pnpm test
```

Nunca aponte `TEST_DATABASE_URL` para o Supabase de produção.

## API (v1)

Todas as rotas, exceto `/health`, exigem `Authorization: Bearer <segredo>` (veja `CENTRAL_API_KEYS`).

| Método | Rota | Uso |
|---|---|---|
| POST | `/v1/buscas` | registra uma busca (UF, cidade, bairros, segmento, CNAEs, porte, quantidade) |
| GET | `/v1/buscas/:id` | status da busca e nº de empresas |
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
