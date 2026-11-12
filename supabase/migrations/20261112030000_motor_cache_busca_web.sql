-- Cache da busca web (V5): reprocessar uma empresa não gasta a cota gratuita de novo.
create table motor.cache_busca_web (
  consulta   text primary key,
  provedor   text not null,
  resultados jsonb not null,
  criado_em  timestamptz not null default now()
);
alter table motor.cache_busca_web enable row level security;
