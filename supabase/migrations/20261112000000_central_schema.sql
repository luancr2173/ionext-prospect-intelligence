-- IONEXT Prospect Intelligence — Central de Oportunidades (schema v1)
-- Todas as tabelas com RLS ligado e sem políticas públicas: o acesso é feito
-- pela API da Central com a connection string de serviço.

create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------- empresa
create table public.empresa (
  id               uuid primary key default gen_random_uuid(),
  -- CNPJ alfanumérico (14 caracteres, DV numérico). Nunca numeric.
  cnpj             text unique check (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  nome_fantasia    text not null,
  razao_social     text,
  nome_normalizado text not null,
  segmento         text,
  cnae_principal   text check (cnae_principal ~ '^[0-9]{7}$'),
  porte            text check (porte in ('MEI','ME','EPP','DEMAIS')),
  data_abertura    date,
  situacao_receita text,
  pais             text not null default 'BR',
  uf               char(2),
  cidade           text,
  bairro           text,
  endereco         text,
  cep              text check (cep ~ '^[0-9]{8}$'),
  lat              double precision,
  lng              double precision,
  geo              extensions.geography(point, 4326)
                   generated always as (
                     case when lat is not null and lng is not null
                       then extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
                     end
                   ) stored,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now()
);
create index empresa_nome_trgm on public.empresa using gin (nome_normalizado extensions.gin_trgm_ops);
create index empresa_geo_idx   on public.empresa using gist (geo);
create index empresa_local_idx on public.empresa (uf, cidade, bairro);
create index empresa_cep_idx   on public.empresa (cep);

-- ------------------------------------------------------------- evidencia
create table public.evidencia (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid references public.empresa(id) on delete cascade,
  fonte          text not null check (fonte in
                   ('receita','osm','fsq_os','rdap','dns','http','busca_web','manual','pagespeed','crawler')),
  url            text,
  coletado_em    timestamptz not null,
  expira_em      timestamptz,
  confiabilidade text not null default 'media' check (confiabilidade in ('alta','media','baixa')),
  payload        jsonb not null default '{}'::jsonb,
  operador       text, -- obrigatório quando fonte = manual
  criado_em      timestamptz not null default now(),
  constraint manual_tem_operador check (fonte <> 'manual' or operador is not null)
);
create index evidencia_empresa_idx on public.evidencia (empresa_id);

-- ------------------------------------------------- identificador_externo
create table public.identificador_externo (
  empresa_id uuid not null references public.empresa(id) on delete cascade,
  fonte      text not null check (fonte in ('receita','osm','fsq_os','google_maps_link','instagram','facebook','dominio')),
  valor      text not null,
  primary key (fonte, valor)
);
create index identificador_empresa_idx on public.identificador_externo (empresa_id);

-- ---------------------------------------------------------------- contato
create table public.contato (
  id                uuid primary key default gen_random_uuid(),
  empresa_id        uuid not null references public.empresa(id) on delete cascade,
  tipo              text not null check (tipo in ('telefone','whatsapp','email','instagram','facebook','linkedin','outro')),
  valor             text not null,
  valor_normalizado text not null,
  publico_comercial boolean not null default false,
  evidencia_id      uuid references public.evidencia(id) on delete set null,
  criado_em         timestamptz not null default now(),
  unique (empresa_id, tipo, valor_normalizado)
);
create index contato_valor_idx on public.contato (tipo, valor_normalizado);

-- ------------------------------------------------------- presenca_digital
create table public.presenca_digital (
  empresa_id     uuid primary key references public.empresa(id) on delete cascade,
  classificacao  text not null check (classificacao in
                   ('SEM_SITE','SOMENTE_REDES','PRESENCA_FRACA','SITE_EXISTENTE','PENDENTE')),
  url_site       text,
  verificacoes   jsonb not null default '{}'::jsonb,
  confiabilidade text not null default 'media' check (confiabilidade in ('alta','media','baixa')),
  motor_versao   text not null,
  verificado_em  timestamptz not null,
  evidencia_ids  uuid[] not null default '{}'
);

-- --------------------------------------------------------------- auditoria
create table public.auditoria (
  id               uuid primary key default gen_random_uuid(),
  empresa_id       uuid not null references public.empresa(id) on delete cascade,
  url              text not null,
  executada_em     timestamptz not null,
  motor_versao     text not null,
  psi              jsonb,
  achados          jsonb not null default '[]'::jsonb,
  pontos_positivos jsonb not null default '[]'::jsonb,
  classe           text not null check (classe in ('B','C','D')),
  screenshots      text[] not null default '{}',
  evidencia_ids    uuid[] not null default '{}'
);
create index auditoria_empresa_idx on public.auditoria (empresa_id, executada_em desc);

-- ------------------------------------------------------------ oportunidade
create table public.oportunidade (
  id                 uuid primary key default gen_random_uuid(),
  empresa_id         uuid not null references public.empresa(id) on delete cascade,
  tipo               text not null check (tipo in ('A','B','C','D')),
  servicos_sugeridos text[] not null default '{}',
  lead_score         smallint check (lead_score between 0 and 100),
  score_detalhe      jsonb not null default '[]'::jsonb,
  prioridade         text check (prioridade in ('alta','media','baixa')),
  status             text not null default 'nova' check (status in
                       ('nova','revisada','aprovada_para_contato','abordada','respondeu',
                        'reuniao','proposta','ganha','perdida','descartada')),
  responsavel        text,
  abordagem          jsonb,
  criado_em          timestamptz not null default now(),
  atualizado_em      timestamptz not null default now(),
  unique (empresa_id, tipo)
);
create index oportunidade_fila_idx on public.oportunidade (status, lead_score desc);

-- ------------------------------------------------------------------- busca
create table public.busca (
  id             uuid primary key default gen_random_uuid(),
  filtros        jsonb not null,
  status         text not null default 'planejada' check (status in
                   ('planejada','executando','concluida','falhou','cancelada')),
  total_celulas  integer not null default 0,
  concluidas     integer not null default 0,
  criado_por     text,
  criado_em      timestamptz not null default now(),
  concluida_em   timestamptz
);

-- Liga cada ingestão à busca que a originou (rastreabilidade + idempotência)
create table public.busca_resultado (
  busca_id   uuid not null references public.busca(id) on delete cascade,
  chave      text not null, -- fonte:valor do identificador principal da candidata
  empresa_id uuid not null references public.empresa(id) on delete cascade,
  acao       text not null check (acao in ('criada','mesclada','revisao_merge')),
  criado_em  timestamptz not null default now(),
  primary key (busca_id, chave)
);

-- ----------------------------------------------------------- revisao_merge
create table public.revisao_merge (
  id            uuid primary key default gen_random_uuid(),
  empresa_a     uuid not null references public.empresa(id) on delete cascade,
  empresa_b     uuid not null references public.empresa(id) on delete cascade,
  similaridade  real not null,
  motivo        text not null,
  status        text not null default 'pendente' check (status in ('pendente','mesclar','manter_separadas')),
  resolvido_por text,
  resolvido_em  timestamptz,
  criado_em     timestamptz not null default now(),
  check (empresa_a <> empresa_b)
);

-- --------------------------------------------------------------- interacao
create table public.interacao (
  id              uuid primary key default gen_random_uuid(),
  oportunidade_id uuid not null references public.oportunidade(id) on delete cascade,
  canal           text not null check (canal in ('whatsapp','telefone','email','presencial','outro')),
  direcao         text not null check (direcao in ('saida','entrada')),
  resumo          text not null,
  resultado       text,
  registrado_por  text not null,
  registrado_em   timestamptz not null default now()
);
create index interacao_oportunidade_idx on public.interacao (oportunidade_id, registrado_em desc);

-- ----------------------------------------------------------------- opt_out
create table public.opt_out (
  chave         text not null check (chave in ('cnpj','telefone','email','dominio')),
  valor         text not null,
  motivo        text,
  registrado_em timestamptz not null default now(),
  primary key (chave, valor)
);

-- --------------------------------------------------- segmento_prioritario
create table public.segmento_prioritario (
  segmento text primary key,
  pontos   smallint not null check (pontos between 0 and 10)
);

-- ------------------------------------------------------------------ RLS
alter table public.empresa               enable row level security;
alter table public.evidencia             enable row level security;
alter table public.identificador_externo enable row level security;
alter table public.contato               enable row level security;
alter table public.presenca_digital      enable row level security;
alter table public.auditoria             enable row level security;
alter table public.oportunidade          enable row level security;
alter table public.busca                 enable row level security;
alter table public.busca_resultado       enable row level security;
alter table public.revisao_merge         enable row level security;
alter table public.interacao             enable row level security;
alter table public.opt_out               enable row level security;
alter table public.segmento_prioritario  enable row level security;

-- ------------------------------------------------------- atualizado_em
create or replace function public.tocar_atualizado_em() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.atualizado_em := now();
  return new;
end $$;

create trigger empresa_atualizado before update on public.empresa
  for each row execute function public.tocar_atualizado_em();
create trigger oportunidade_atualizado before update on public.oportunidade
  for each row execute function public.tocar_atualizado_em();
