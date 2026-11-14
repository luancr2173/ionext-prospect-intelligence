-- CRM: motivo de perda e tarefas com data.

alter table public.oportunidade
  add column if not exists motivo_perda text,
  add column if not exists motivo_perda_obs text;
do $$ begin
  alter table public.oportunidade add constraint oportunidade_motivo_perda_ck check (
    motivo_perda is null or motivo_perda in ('preco', 'sem_interesse', 'ja_tem_fornecedor', 'parou_de_responder', 'momento', 'outro'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.oportunidade add constraint oportunidade_motivo_perda_obs_ck check (motivo_perda_obs is null or length(motivo_perda_obs) <= 500);
exception when duplicate_object then null; end $$;

-- Tarefas ligadas a uma oportunidade ("ligar terça", "enviar proposta"); aparecem no "Para hoje" quando vencem.
create table if not exists public.tarefa (
  id              uuid primary key default gen_random_uuid(),
  oportunidade_id uuid not null references public.oportunidade(id) on delete cascade,
  titulo          text not null check (length(titulo) between 1 and 200),
  vence_em        date not null,
  concluida_em    timestamptz,
  criada_por      text not null,
  criada_em       timestamptz not null default now()
);
create index if not exists tarefa_oportunidade_idx on public.tarefa (oportunidade_id, vence_em);
create index if not exists tarefa_aberta_idx on public.tarefa (vence_em) where concluida_em is null;
alter table public.tarefa enable row level security;
