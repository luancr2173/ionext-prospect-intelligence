-- Motor 01 — Prospecting Engine: dados próprios do motor (não fazem parte da Central).
-- Schemas fora de "public" não são expostos pela API REST do Supabase.

create schema if not exists receita;
create schema if not exists motor;

-- Base da Receita filtrada (UF/município/CNAEs-alvo, situação ATIVA)
create table receita.estabelecimento (
  cnpj               text primary key check (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  cnpj_basico        text not null,
  matriz             boolean not null,
  nome_fantasia      text,
  razao_social       text,
  situacao           text not null,
  data_inicio        date,
  cnae_principal     text not null,
  cnaes_secundarios  text[] not null default '{}',
  logradouro         text,
  bairro             text,
  bairro_normalizado text,
  cep                text,
  uf                 char(2) not null,
  municipio_codigo   text not null,
  municipio_nome     text not null,
  telefones          text[] not null default '{}',
  email              text,
  porte              text check (porte in ('ME','EPP','DEMAIS')),
  simples            boolean,
  mei                boolean,
  referencia         text not null,  -- mês da base, ex.: 2026-10
  carregado_em       timestamptz not null default now()
);
create index estab_busca_idx on receita.estabelecimento (uf, municipio_nome, cnae_principal);
create index estab_bairro_idx on receita.estabelecimento (bairro_normalizado);

create table receita.carga (
  id           uuid primary key default gen_random_uuid(),
  referencia   text not null,
  filtros      jsonb not null,
  linhas_lidas bigint not null default 0,
  carregadas   integer not null default 0,
  iniciada_em  timestamptz not null default now(),
  concluida_em timestamptz,
  erro         text
);

-- Catálogo de POIs do OpenStreetMap por UF + segmento (cache; Overpass não deve ser consultado por empresa)
create table motor.catalogo_osm (
  osm_id           text not null,          -- node/123, way/456
  uf               char(2) not null,
  segmento         text not null,
  nome             text not null,
  nome_normalizado text not null,
  tags             jsonb not null,
  lat              double precision,
  lng              double precision,
  atualizado_em    timestamptz not null default now(),
  primary key (uf, segmento, osm_id)
);

-- Uso mensal dos provedores gratuitos de busca web (para nunca passar da cota grátis)
create table motor.uso_busca_web (
  provedor  text not null,
  mes       text not null,  -- 2026-11
  consultas integer not null default 0,
  primary key (provedor, mes)
);

-- Fila para a varredura feita pelo Claude (tarefa agendada) quando as cotas acabam ou não há chave.
-- O Claude só preenche URLs encontradas; o motor verifica cada uma antes de usar.
create table motor.fila_busca_web (
  id            uuid primary key default gen_random_uuid(),
  cnpj          text not null,
  busca_id      uuid,
  consulta      text not null,
  contexto      jsonb not null,
  prioridade    smallint not null default 0,
  status        text not null default 'pendente' check (status in ('pendente','em_andamento','concluida','descartada')),
  resultado     jsonb,
  pego_em       timestamptz,
  concluido_em  timestamptz,
  processado_em timestamptz,
  criado_em     timestamptz not null default now()
);
create unique index fila_busca_web_aberta on motor.fila_busca_web (cnpj) where status in ('pendente','em_andamento');
create index fila_busca_web_prox on motor.fila_busca_web (status, prioridade desc, criado_em);

-- Progresso por busca e controle de reprocessamento
create table motor.busca_progresso (
  busca_id    uuid primary key,
  total       integer not null,
  processadas integer not null default 0,
  falhas      integer not null default 0,
  atualizado_em timestamptz not null default now()
);

create table motor.empresa_processada (
  cnpj          text primary key,
  processado_em timestamptz not null,
  resultado     jsonb
);

alter table receita.estabelecimento  enable row level security;
alter table receita.carga            enable row level security;
alter table motor.catalogo_osm       enable row level security;
alter table motor.uso_busca_web      enable row level security;
alter table motor.fila_busca_web     enable row level security;
alter table motor.busca_progresso    enable row level security;
alter table motor.empresa_processada enable row level security;

-- Quando o catálogo OSM de (UF, segmento) foi atualizado com sucesso (distingue "vazio" de "nunca carregado")
create table motor.catalogo_osm_atualizacao (
  uf            char(2) not null,
  segmento      text not null,
  total         integer not null,
  atualizado_em timestamptz not null default now(),
  primary key (uf, segmento)
);
alter table motor.catalogo_osm_atualizacao enable row level security;
