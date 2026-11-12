-- Painel: busca pode ser marcada para reprocessar; motores reportam sinal de vida e métricas à Central.
alter table public.busca drop constraint busca_status_check;
alter table public.busca add constraint busca_status_check
  check (status in ('planejada','executando','concluida','falhou','cancelada','reprocessar'));

create table public.motor_status (
  nome          text primary key,
  dados         jsonb not null,
  atualizado_em timestamptz not null default now()
);
alter table public.motor_status enable row level security;
