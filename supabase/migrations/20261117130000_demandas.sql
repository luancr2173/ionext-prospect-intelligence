-- Demandas: trabalhos de cliente (ex.: criar o site da Clínica X) e tarefas internas da IONEXT,
-- num quadro A fazer → Em andamento → Aguardando cliente → Concluída.

create table if not exists public.demanda (
  id            uuid primary key default gen_random_uuid(),
  titulo        text not null check (length(btrim(titulo)) between 1 and 160),
  descricao     text check (descricao is null or length(descricao) <= 4000),
  tipo          text not null default 'outro'
                check (tipo in ('atendimento', 'agendamento', 'acompanhamento', 'dashboards', 'sites', 'interno', 'outro')),
  status        text not null default 'a_fazer' check (status in ('a_fazer', 'andamento', 'aguardando', 'concluida')),
  prioridade    text not null default 'media' check (prioridade in ('alta', 'media', 'baixa')),
  empresa_id    uuid references public.empresa(id) on delete set null,  -- cliente da base (opcional)
  cliente_nome  text check (cliente_nome is null or length(cliente_nome) <= 160),  -- cliente fora da base
  prazo         date,
  valor         numeric(12,2) check (valor is null or valor >= 0),
  checklist     jsonb not null default '[]'::jsonb,                       -- [{texto, feito}]
  posicao       double precision not null default 0,                     -- ordem dentro da coluna
  arquivada     boolean not null default false,
  concluida_em  timestamptz,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists demanda_quadro_idx on public.demanda (status, posicao) where not arquivada;
create index if not exists demanda_empresa_idx on public.demanda (empresa_id) where empresa_id is not null;
alter table public.demanda enable row level security;

create table if not exists public.demanda_nota (
  id         uuid primary key default gen_random_uuid(),
  demanda_id uuid not null references public.demanda(id) on delete cascade,
  texto      text not null check (length(btrim(texto)) between 1 and 2000),
  autor      text not null,
  criado_em  timestamptz not null default now()
);
create index if not exists demanda_nota_idx on public.demanda_nota (demanda_id, criado_em);
alter table public.demanda_nota enable row level security;
