# IONEXT Prospect Intelligence — Arquitetura v0.2

> Status: aprovada para a Fase 0 · 12/11/2026
> Decisões: TypeScript em tudo · Supabase em projeto próprio (`ionext-prospect-intelligence`, sa-east-1) · repositório novo no GitHub · **sem Google Places API paga** · o CRM anterior foi cancelado, então a Central também faz o funil comercial e a exportação
> Escopo: Motor 01 (Prospecting), Motor 02 (Website Audit), Central de Oportunidades, integração com o Neo.

---

## 1. Visão geral

```
                ┌──────────────────────────── Painel Web (Next.js) ───────────────────────────┐
                │ buscas · lista/ficha · filtros · score · aprovação p/ Neo · status · export │
                └───────────────────────────────────────┬─────────────────────────────────────┘
                                                        │ REST (JWT Supabase)
                ┌───────────────────────────────────────▼─────────────────────────────────────┐
                │                  CENTRAL DE OPORTUNIDADES  (API + Postgres)                  │
                │ empresas únicas · dedup · evidências · score · oportunidades · status · LGPD │
                └───────▲──────────────────────▲───────────────────────────────┬──────────────┘
                        │ contrato EmpresaCandidata                            │ contrato ContextoNeo
                        │ contrato DiagnosticoSite                             ▼
     ┌──────────────────┴─────────┐   ┌───────────────┴──────────────┐   ┌─────────────────────┐
     │ MOTOR 01 · PROSPECTING     │   │ MOTOR 02 · WEBSITE AUDIT      │   │ n8n · Agente Neo    │
     │ descoberta → verificação   │   │ PageSpeed/Lighthouse + crawler│   │ (já existente)      │
     │ de presença → classificação│   │ → diagnóstico com evidências  │   │ só envia o que foi  │
     └──────────────┬─────────────┘   └───────────────┬──────────────┘   │ aprovado            │
                    │                                  │                  └─────────────────────┘
                    └────────── Fila de jobs (pg-boss, no próprio Postgres) ─────┘
```

Princípios:
1. Os motores **não se conhecem**. Cada um consome jobs da fila e devolve resultados à Central por contrato.
2. A Central é o **único dono** do cadastro de empresas, da deduplicação, do score e do status comercial.
3. **Todo dado tem fonte, URL e data** (tabela `evidencia`). Sem evidência, o campo fica vazio e o score não conta.
4. **Nenhuma mensagem sai sem aprovação humana.** O Neo só lê a fila `aprovado_para_contato`.

---

## 2. Stack proposta

| Camada | Escolha | Por quê |
|---|---|---|
| Linguagem | TypeScript (Node 20+) em monorepo (pnpm workspaces) | Um idioma para API, motores e painel; Lighthouse/Playwright são nativos de Node |
| API da Central | Fastify + Zod (validação dos contratos) | Leve, rápido, contratos tipados e exportáveis em OpenAPI |
| Banco | PostgreSQL (Supabase) + extensões `pg_trgm`, `unaccent`, `postgis` | Já usado no CRM da IONEXT; trigram para dedup de nomes; PostGIS para proximidade |
| Fila | pg-boss (fila sobre o próprio Postgres) | Retentativas, backoff, agendamento e concorrência sem Redis; troca por BullMQ se escalar |
| Crawler/auditoria | Playwright (headless Chromium) + Google PageSpeed Insights API | Renderização real, screenshots como evidência, métricas Lighthouse oficiais |
| Painel | Next.js + Supabase Auth | Mesmo ecossistema do site/CRM |
| Neo | n8n existente, consumindo a API da Central | Não reescrever o que já funciona |
| Deploy | Docker Compose em VPS (API + workers); painel na Vercel | Workers com Chromium não cabem bem em serverless |

---

## 3. Fontes de dados e o papel de cada uma

Tudo abaixo é gratuito. Cada fonte é um **adaptador plugável**: se amanhã entrar uma fonte paga, ela vira mais um adaptador sem mexer no resto.

| Fonte | Uso | Restrições que mudam o design |
|---|---|---|
| **Dados abertos CNPJ (Receita Federal)** — fonte principal de descoberta | Descoberta por CNAE + município + bairro; razão social, CNPJ, data de abertura, situação cadastral, porte (MEI/ME/EPP), telefone e e-mail declarados | Arquivos mensais grandes → ETL carrega só as UFs e os CNAEs de interesse em `receita_estabelecimento`. **CNPJ alfanumérico**: emissão começou em 31/07/2026, mantém 14 caracteres → `cnpj` é `text` validado por regex, nunca numérico. Telefone/e-mail de MEI podem ser dado pessoal (LGPD). |
| **OpenStreetMap (Overpass API)** | Confirmação de endereço/geo, tags `website`, `contact:*`, `opening_hours` | Cobertura irregular no Brasil; serve como sinal, nunca como prova de ausência |
| **Foursquare OS Places** (dataset aberto, Apache 2.0) | Casamento de POIs com site/telefone; sinal extra para V2 | Download em lote filtrado por Brasil; atualização periódica; cobertura a validar na Fase 3 |
| **RDAP (registro.br) / DNS / HTTP** | Verificar domínios candidatos (`nomefantasia.com.br`, domínio do e-mail declarado): registrado? resolve? responde? | Gratuito; rate-limit educado, cache por domínio |
| **Busca web (opcional, plugável)** | V5: procurar site próprio não listado em outra fonte | Sem fornecedor gratuito estável hoje: o Brave encerrou o plano grátis em 2026 e passou a dar US$ 5/mês de crédito (cerca de 1.000 buscas, exige cartão). Padrão: **desligado** → V5 fica "não executado" e reduz a confiabilidade da ficha para "média". |
| **Verificação manual no painel** | Operador abre o Google Maps/Instagram no navegador e registra link do perfil, nota, nº de avaliações, link na bio | Evidência com `fonte = manual`, operador e data. Substitui as avaliações que viriam do Places sem scraping e sem violar termos. |
| **PageSpeed Insights API** | Métricas Lighthouse mobile e desktop | Gratuita com chave e cota diária; fallback: Lighthouse local no worker |

Não usar: scraping automatizado do Google Maps, Instagram ou Facebook (viola os termos das plataformas).

---

## 4. Motor 01 — Prospecting Engine

### 4.1 Pipeline

```
[BuscaSolicitada]
   │
   ▼
1. PLANEJAR        divide a área em células (bairros ou grade geográfica) para ir
                   além dos primeiros resultados; cada célula vira um job
   ▼
2. DESCOBRIR       por célula: Receita (CNAE+município+bairro, situação ATIVA)
                   + OSM (Overpass) + FSQ OS Places
   ▼
3. CASAR           liga registros das fontes (nome normalizado + endereço + telefone
                   + proximidade) → EmpresaCandidata com evidências
   ▼
4. VERIFICAR       checklist de presença digital (4.2), cada passo gera evidência
   ▼
5. CLASSIFICAR     SEM_SITE | SOMENTE_REDES | PRESENCA_FRACA | SITE_EXISTENTE | PENDENTE
   ▼
6. ENTREGAR        POST /v1/ingest/candidatas → Central
                   se achou site → Central agenda job no Motor 02
```

### 4.2 Verificação "tem site?" (regra central)

Nenhuma empresa vira `SEM_SITE` só porque o Google Maps não mostra site. Para receber essa classificação, **todos** os passos abaixo precisam ter sido executados sem achar site próprio:

| # | Verificação | Evidência gravada |
|---|---|---|
| V1 | site informado em verificação manual (perfil do Google visto pelo operador) ou no FSQ OS Places | link do perfil / id FSQ |
| V2 | tag `website` no OSM | id do elemento |
| V3 | e-mail com domínio próprio na Receita (ex.: `@clinicax.com.br`) → testar o domínio | domínio + resultado HTTP |
| V4 | domínios candidatos gerados do nome fantasia (`.com.br`, `.com`) → RDAP + DNS + HTTP | lista testada + resultado |
| V5 | busca web `"nome fantasia" + cidade` → filtrar diretórios/redes → validar se algum resultado é o site da empresa (nome/telefone/endereço batem) | consultas + URLs avaliadas |
| V6 | links encontrados apontam só para redes/WhatsApp/linktree? | URLs |

Passos obrigatórios: **V2, V3 (quando houver e-mail), V4 e V6**. V1 e V5 são opcionais e elevam a confiabilidade.

Regras de saída:
- Site próprio encontrado e acessível → `SITE_EXISTENTE` (o Motor 02 decide se é `PRESENCA_FRACA`)
- Nada encontrado nos passos executados, mas há Instagram/Facebook/WhatsApp → `SOMENTE_REDES`
- Nada encontrado nos passos executados e nenhuma rede → `SEM_SITE`
- Algum passo obrigatório falhou (timeout, cota, erro) ou não executou → `PENDENTE` (reprocessa depois)
- Confiabilidade: **alta** se V1 e V5 também rodaram; **média** se só os obrigatórios rodaram
- Domínio registrado mas fora do ar → `PRESENCA_FRACA` com evidência "domínio sem resposta"

---

## 5. Motor 02 — Website Audit Engine

Entrada: `AuditoriaSolicitada { empresa_id, url }`. Saída: `DiagnosticoSite`.

| Dimensão | Como medir | Evidência |
|---|---|---|
| Desempenho | PSI mobile + desktop (LCP, CLS, INP/TBT, score) | JSON PSI salvo |
| Responsividade | meta viewport; render 390px vs 1440px; overflow horizontal | 2 screenshots |
| HTTPS/segurança | certificado válido, redirect http→https, mixed content | cabeçalhos |
| SEO básico | title, meta description, H1, sitemap, robots, score SEO do PSI | trechos do HTML |
| Links e formulários | crawl de até N páginas internas; status dos links; formulários com action | lista de falhas por página |
| Conversão | CTA visível acima da dobra; link de WhatsApp/telefone clicável; endereço/horário | screenshot + seletores |
| Conteúdo/atualização | ano do rodapé, datas de posts, links de redes quebrados, **só como sinais combinados** | trechos |
| Oportunidades de IA | ausência de chat/WhatsApp, formulário sem resposta automática, agendamento manual | lista |

Classificação comercial (regras explícitas, não "impressão"):
- **B (desatualizado):** pelo menos 2 falhas graves entre sem HTTPS, sem viewport mobile, PSI mobile < 30, links principais quebrados, formulário quebrado
- **C (funcional com problemas):** 1 falha grave ou 3+ problemas moderados (SEO incompleto, sem CTA, PSI mobile 30–59)
- **D (moderno):** nenhum dos anteriores → ainda gera oportunidade de automação/IA se não houver atendimento automatizado

"Pontos positivos" também são gravados, para o Neo poder elogiar algo real antes de sugerir melhoria.

---

## 6. Central de Oportunidades

### 6.1 Modelo de dados (resumo)

```
empresa              id, cnpj(char14 alfanum, nullable, unique), nome_fantasia, razao_social,
                     nome_normalizado, segmento, cnae_principal, data_abertura,
                     pais, uf, cidade, bairro, endereco, cep, geo(point),
                     situacao_receita, criado_em, atualizado_em

identificador_externo empresa_id, fonte(google_place|osm|receita|instagram|...), valor, unique(fonte,valor)

contato              empresa_id, tipo(telefone|whatsapp|email|instagram|facebook|linkedin|outro),
                     valor, publico_comercial(bool), evidencia_id

presenca_digital     empresa_id, classificacao, url_site, verificacoes(jsonb V1..V6),
                     verificado_em, evidencia_ids[]

auditoria            id, empresa_id, url, executada_em, psi(jsonb), achados(jsonb),
                     pontos_positivos(jsonb), classe(B|C|D), screenshots[]

oportunidade         id, empresa_id, tipo(A|B|C|D), servicos_sugeridos[], lead_score,
                     score_detalhe(jsonb), prioridade(alta|media|baixa),
                     status(nova|revisada|aprovada_para_contato|abordada|respondeu|
                            reuniao|proposta|ganha|perdida|descartada), responsavel

evidencia            id, empresa_id, fonte, url, coletado_em, payload(jsonb), expira_em,
                     confiabilidade(alta|media|baixa)

busca                id, filtros(jsonb), status, total_celulas, concluidas, custo_estimado, criado_por

interacao            oportunidade_id, canal, direcao, resumo, resultado, registrado_em

opt_out              chave(cnpj|telefone|email|dominio), valor, motivo, registrado_em
```

Uma empresa pode ter várias `oportunidade` (ex.: A para site e D para automação) sem duplicar `empresa`.

### 6.2 Deduplicação (ordem de força)

1. `cnpj` igual → mesma empresa
2. `identificador_externo` igual (ex.: mesmo `place_id`) → mesma empresa
3. Telefone normalizado E.164 igual + distância < 300 m → mesma empresa
4. Similaridade de nome (trigram ≥ 0,7) + mesmo CEP ou distância < 100 m → **candidata a merge**, vai para revisão no painel (sem merge automático)

### 6.3 Lead Score (0–100), só com dados verificados

| Critério | Pontos | Exige evidência |
|---|---|---|
| Presença digital: SEM_SITE 35 · SOMENTE_REDES 30 · B 25 · C 15 · D 5 · PENDENTE 0 | até 35 | `presenca_digital` / `auditoria` |
| Ativa: Receita ATIVA 10 · presente em OSM/FSQ ou perfil verificado manualmente 5 · atividade recente (avaliação ou post < 90 dias, registrada manualmente) 5 | até 20 | Receita / OSM / FSQ / manual |
| Contato: telefone comercial 10 · WhatsApp publicado pela empresa 10 | até 20 | `contato.evidencia_id` |
| Tração: avaliações registradas manualmente ≥ 50 → 15 · 20–49 → 10 · 5–19 → 5; sem registro manual: empresa com ≥ 3 anos e porte ME/EPP → 5 | até 15 | manual / Receita |
| Segmento prioritário (tabela configurável) | até 10 | configuração |

Prioridade: **alta ≥ 70 · média 45–69 · baixa < 45**. `score_detalhe` guarda cada linha com o motivo e o `evidencia_id`, para mostrar no painel e passar ao Neo. Empresa em `opt_out` não recebe score e some das filas.

---

## 7. Contratos de integração (v1)

### 7.1 Motor 01 → Central — `POST /v1/ingest/candidatas`
```json
{
  "busca_id": "uuid",
  "motor": "prospecting@1.0.0",
  "candidatas": [{
    "nome_fantasia": "string", "razao_social": "string|null", "cnpj": "string|null",
    "segmento": "string", "cnae_principal": "string|null",
    "endereco": { "uf": "DF", "cidade": "Brasília", "bairro": "string", "logradouro": "string", "cep": "string", "lat": 0, "lng": 0 },
    "identificadores": [{ "fonte": "google_place", "valor": "ChIJ..." }],
    "contatos": [{ "tipo": "telefone", "valor": "+5561...", "publico_comercial": true, "evidencia_ref": "e1" }],
    "presenca": { "classificacao": "SOMENTE_REDES", "url_site": null, "verificacoes": { "V1": "sem_site", "V2": "sem_tag", "V3": "nao_aplicavel", "V4": "nenhum_dominio_ativo", "V5": "nenhum_resultado_proprio", "V6": "so_instagram" } },
    "evidencias": [{ "ref": "e1", "fonte": "google_places", "url": "https://maps.google.com/?cid=...", "coletado_em": "ISO-8601", "expira_em": "ISO-8601|null", "payload": {} }]
  }]
}
```
Resposta: `{ "resultados": [{ "empresa_id": "uuid", "acao": "criada|mesclada|revisao_merge", "auditoria_agendada": false }] }`. Idempotente por `(busca_id, identificador)`.

### 7.2 Motor 02 → Central — `POST /v1/ingest/diagnosticos`
```json
{ "empresa_id": "uuid", "url": "https://...", "executada_em": "ISO-8601", "motor": "audit@1.0.0",
  "psi": { "mobile": { "performance": 0.42, "seo": 0.8, "lcp_ms": 5400 }, "desktop": {} },
  "achados": [{ "dimensao": "https", "gravidade": "grave|moderado|leve", "descricao": "string", "pagina": "url", "evidencia_ref": "s1" }],
  "pontos_positivos": ["string"], "classe": "B", "evidencias": [] }
```

### 7.3 Central → Neo (n8n) — `GET /v1/neo/fila?status=aprovada_para_contato`
```json
{
  "oportunidade_id": "uuid", "tipo": "A", "prioridade": "alta", "lead_score": 78,
  "empresa": { "nome": "string", "segmento": "string", "bairro": "string", "cidade": "string" },
  "canal_contato": { "tipo": "whatsapp", "valor": "+55...", "fonte": "perfil Google da empresa" },
  "diagnostico": { "resumo": "Atende só pelo Instagram, 84 avaliações nota 4,8, sem site próprio encontrado.", "pontos_positivos": [], "problemas": [] },
  "solucoes_sugeridas": ["site institucional com CTA WhatsApp", "agente de atendimento"],
  "abordagem": { "gancho": "string", "tom": "consultivo", "evitar": ["dizer que o site é ruim", "promessas de resultado"] },
  "fontes": [{ "url": "string", "data": "ISO-8601" }]
}
```
Depois do envio, o n8n chama `POST /v1/oportunidades/{id}/interacoes` e `PATCH /v1/oportunidades/{id}` (status `abordada`). Resposta "não quero contato" → `POST /v1/opt-out`.

O texto do gancho é gerado por LLM **a partir só dos campos acima** (sem dados fora do contexto) e revisado no painel antes da aprovação.

### 7.4 Outros endpoints do painel
`POST /v1/buscas` · `GET /v1/buscas/{id}` · `GET /v1/empresas?segmento=&uf=&cidade=&classificacao=&prioridade=&ordenar=score` · `GET /v1/empresas/{id}` (ficha completa) · `POST /v1/merges/{id}/resolver` · `GET /v1/export?formato=csv|xlsx|json&filtros...`

---

## 8. Erros, retentativas e rastreabilidade
- Cada job: `tentativas=5`, backoff exponencial (30 s → 8 min), dead-letter visível no painel.
- Erros de cota (429) pausam só a fila daquela fonte (circuit breaker por fonte).
- Toda chamada externa grava `fonte, url, status, latência, custo_estimado`, que alimenta o custo por busca.
- Versão do motor em cada resultado (`prospecting@1.0.0`), para reprocessar quando a regra mudar.

## 9. LGPD e políticas
- Base legal: legítimo interesse para prospecção B2B, com registro do teste de balanceamento (LIA) e aviso de privacidade no site da IONEXT.
- Só contatos **publicados pela empresa para fins comerciais**; telefone/e-mail de MEI na Receita marcados como `publico_comercial=false` até haver confirmação em canal comercial.
- `opt_out` verificado antes de entrar na fila do Neo e antes de cada envio.
- Retenção: snapshots do Google expiram e são re-hidratados; empresas descartadas são anonimizadas após prazo configurável.
- Primeira mensagem do Neo sempre identifica a IONEXT e oferece saída ("se preferir não receber, é só avisar").

## 10. Dependências e custos a provisionar

| Item | Necessário para | Observação |
|---|---|---|
| Supabase `ionext-prospect-intelligence` (criado, plano gratuito) | Central | O plano gratuito tem 500 MB → a base da Receita entra filtrada (UF + CNAEs-alvo), não inteira |
| Chave PageSpeed Insights API (Google Cloud, gratuita, sem faturamento) | Motor 02 | Fase 4 |
| Busca web (opcional) | V5 | Desligada por padrão; liga quando houver orçamento |
| Chave LLM (OpenAI/Anthropic) | ganchos/análise comercial | Já usada no Neo |
| VPS com Docker | workers Playwright | Pode ser a mesma do n8n se houver RAM (≥ 4 GB recomendado) |

## 11. Roadmap de implementação

| Fase | Entrega | Critério de pronto |
|---|---|---|
| **0 · Fundação** | monorepo, schema + migrations, API da Central com ingest/dedup/evidências, fila, auth | testes de dedup e idempotência passando |
| **1 · Motor 01 MVP** | ETL Receita (1 UF, CNAEs-alvo) + Overpass + verificação V2, V3, V4, V6 + classificação + score | busca real de 1 segmento em 2–3 bairros, com fichas e evidências conferíveis |
| **2 · Painel** | lista, ficha, filtros, verificação manual, revisão de merge, aprovação, export CSV/XLSX/JSON | operação comercial usa sem tocar no banco |
| **3 · FSQ OS Places + V1/V5** | casamento com FSQ, busca web plugável | % de PENDENTE cai e confiabilidade sobe |
| **4 · Motor 02** | PSI + crawler + diagnóstico B/C/D | relatório de auditoria com evidência por achado |
| **5 · Neo** | endpoint de fila, workflow n8n de leitura, interações, opt-out | 1 abordagem real aprovada manualmente, registrada ponta a ponta |

## 12. Decisões pendentes
1. UF, cidade, bairros e segmento da primeira busca real (sugestão: 1 segmento × 2–3 bairros de Brasília)
2. Ligar ou não a busca web (V5) e com qual fornecedor
