-- Orçamentos salvos (com status) e contratos gerados a partir do orçamento APROVADO (22/11).
-- * ionext_dados: qualificação da IONEXT como CONTRATADA (uma linha só, editada na aba Precificação);
-- * orcamento: foto dos itens e valores no momento do orçamento, condições de pagamento e prazos, status
--   pendente → aprovado | recusado; "contratante" complementa o cadastro da empresa (representante, endereço…);
-- * contrato: um por orçamento; guarda a foto dos dados usados (para o contrato não mudar se o cadastro mudar).

create table if not exists public.ionext_dados (
  id smallint primary key default 1 check (id = 1),
  razao_social text,
  nome_fantasia text not null default 'IONEXT',
  cnpj text,
  endereco text,
  cidade text,
  uf char(2),
  cep text,
  email text,
  telefone text,
  representante_nome text,
  representante_cpf text,
  representante_cargo text,
  foro_cidade text,
  foro_uf char(2),
  atualizado_em timestamptz not null default now()
);
insert into public.ionext_dados (id) values (1) on conflict (id) do nothing;

create sequence if not exists public.orcamento_numero_seq;

create table if not exists public.orcamento (
  id uuid primary key default gen_random_uuid(),
  numero int not null unique default nextval('public.orcamento_numero_seq'),
  empresa_id uuid not null references public.empresa(id) on delete restrict,
  oportunidade_id uuid references public.oportunidade(id) on delete set null,
  itens jsonb not null check (jsonb_typeof(itens) = 'array' and jsonb_array_length(itens) > 0),
  desconto jsonb not null default '{}'::jsonb,
  valor_unico numeric(12,2) not null default 0 check (valor_unico >= 0),
  valor_mensal numeric(12,2) not null default 0 check (valor_mensal >= 0),
  valor_anual numeric(12,2) not null default 0 check (valor_anual >= 0),
  desconto_unico numeric(12,2) not null default 0,
  desconto_mensal numeric(12,2) not null default 0,
  forma_pagamento text,          -- ex.: "PIX ou boleto"
  condicao_pagamento text,       -- ex.: "50% na assinatura e 50% na entrega"
  vencimento_mensal smallint check (vencimento_mensal between 1 and 28),
  prazo_entrega_dias int check (prazo_entrega_dias between 1 and 730),
  validade date,
  fidelidade_meses smallint check (fidelidade_meses between 0 and 60),
  contratante jsonb not null default '{}'::jsonb,
  observacoes text,
  status text not null default 'pendente' check (status in ('pendente', 'aprovado', 'recusado')),
  aprovado_em timestamptz,
  recusado_em timestamptz,
  motivo_recusa text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists orcamento_empresa_idx on public.orcamento (empresa_id, criado_em desc);
create index if not exists orcamento_status_idx on public.orcamento (status, criado_em desc);

create table if not exists public.contrato (
  id uuid primary key default gen_random_uuid(),
  orcamento_id uuid not null unique references public.orcamento(id) on delete cascade,
  numero text not null unique,
  dados jsonb not null,
  versao int not null default 1,
  gerado_em timestamptz not null default now()
);

do $$ declare r text; t text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      foreach t in array array['ionext_dados', 'orcamento', 'contrato'] loop
        execute format('revoke all on public.%I from %I', t, r);
      end loop;
      execute format('revoke all on sequence public.orcamento_numero_seq from %I', r);
    end if;
  end loop;
end $$;
alter table public.ionext_dados enable row level security;
alter table public.orcamento enable row level security;
alter table public.contrato enable row level security;
