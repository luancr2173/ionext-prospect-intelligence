-- Tempo em cada etapa do funil (CRM): "parada há N dias" e histórico de mudanças de status.
-- atualizado_em muda em qualquer update (reprocessamento, score...), então não serve para medir a etapa.

alter table public.oportunidade add column if not exists etapa_desde timestamptz;
update public.oportunidade set etapa_desde = atualizado_em where etapa_desde is null;
alter table public.oportunidade alter column etapa_desde set default now();
alter table public.oportunidade alter column etapa_desde set not null;

create table if not exists public.oportunidade_etapa (
  id              bigint generated always as identity primary key,
  oportunidade_id uuid not null references public.oportunidade(id) on delete cascade,
  de              text,
  para            text not null,
  por             text,
  em              timestamptz not null default now()
);
create index if not exists oportunidade_etapa_op_idx on public.oportunidade_etapa (oportunidade_id, em desc);
alter table public.oportunidade_etapa enable row level security;

create or replace function public.registrar_etapa() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.etapa_desde := coalesce(new.etapa_desde, now());
  elsif new.status is distinct from old.status then
    new.etapa_desde := now();
  end if;
  return new;
end $$;

create or replace function public.historico_etapa() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into oportunidade_etapa (oportunidade_id, de, para, por)
    values (new.id, case when tg_op = 'UPDATE' then old.status end, new.status, new.responsavel);
  end if;
  return null;
end $$;

drop trigger if exists oportunidade_etapa_desde on public.oportunidade;
create trigger oportunidade_etapa_desde before insert or update of status on public.oportunidade
  for each row execute function public.registrar_etapa();

drop trigger if exists oportunidade_historico_etapa on public.oportunidade;
create trigger oportunidade_historico_etapa after insert or update of status on public.oportunidade
  for each row execute function public.historico_etapa();
