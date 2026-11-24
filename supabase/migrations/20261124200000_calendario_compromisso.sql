-- Calendário (demanda "calendario", 24/11): aba no painel que junta, mês a mês,
--   • as demandas (pelo vencimento),
--   • as reuniões do funil (oportunidade.reuniao_em),
--   • os compromissos: reuniões e outros horários marcados pelo painel ou trazidos do Google Agenda.

create table if not exists public.compromisso (
  id            uuid primary key default gen_random_uuid(),
  titulo        text not null check (length(btrim(titulo)) between 1 and 200),
  descricao     text check (descricao is null or length(descricao) <= 4000),
  local         text check (local is null or length(local) <= 300),
  tipo          text not null default 'reuniao' check (tipo in ('reuniao', 'compromisso', 'lembrete')),
  inicio        timestamptz not null,
  fim           timestamptz check (fim is null or fim >= inicio),
  dia_inteiro   boolean not null default false,
  empresa_id    uuid references public.empresa(id) on delete set null,
  origem        text not null default 'painel' check (origem in ('painel', 'google')),
  externo_id    text check (externo_id is null or length(externo_id) <= 300),  -- id do evento no Google Agenda
  link          text check (link is null or length(link) <= 1000),             -- link do evento / da chamada
  cancelado     boolean not null default false,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists compromisso_inicio_idx on public.compromisso (inicio) where not cancelado;
create unique index if not exists compromisso_externo_uk on public.compromisso (origem, externo_id) where externo_id is not null;
alter table public.compromisso enable row level security;

-- Google Agenda → painel. O n8n (usuário neo_n8n, que só executa funções) manda os eventos de uma janela
-- [p_de, p_ate) e a função espelha: cria/atualiza pelo id do Google e marca como cancelado o que sumiu de lá.
-- p_eventos: [{id, titulo, descricao, local, inicio, fim, dia_inteiro, link}]
create schema if not exists jarvis;
revoke all on schema jarvis from public;

create or replace function jarvis.sincronizar_agenda(p_eventos jsonb, p_de timestamptz, p_ate timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ids text[]; v_upsert int; v_cancel int;
begin
  if jsonb_typeof(p_eventos) is distinct from 'array' then
    return jsonb_build_object('ok', false, 'erro', 'p_eventos precisa ser uma lista');
  end if;
  if p_ate <= p_de or p_ate - p_de > interval '400 days' then
    return jsonb_build_object('ok', false, 'erro', 'janela inválida');
  end if;

  with ev as (
    select left(nullif(btrim(e->>'id'), ''), 300) as externo_id,
           left(coalesce(nullif(btrim(e->>'titulo'), ''), '(sem título)'), 200) as titulo,
           left(nullif(btrim(e->>'descricao'), ''), 4000) as descricao,
           left(nullif(btrim(e->>'local'), ''), 300) as local,
           (e->>'inicio')::timestamptz as inicio,
           nullif(e->>'fim', '')::timestamptz as fim,
           coalesce((e->>'dia_inteiro')::boolean, false) as dia_inteiro,
           left(nullif(btrim(e->>'link'), ''), 1000) as link
      from jsonb_array_elements(p_eventos) e
     where nullif(btrim(e->>'id'), '') is not null and nullif(e->>'inicio', '') is not null
  ), up as (
    insert into compromisso (titulo, descricao, local, tipo, inicio, fim, dia_inteiro, origem, externo_id, link)
    select titulo, descricao, local, 'compromisso', inicio,
           case when fim is not null and fim >= inicio then fim end, dia_inteiro, 'google', externo_id, link
      from ev
    on conflict (origem, externo_id) where externo_id is not null do update set
      titulo = excluded.titulo, descricao = excluded.descricao, local = excluded.local,
      inicio = excluded.inicio, fim = excluded.fim, dia_inteiro = excluded.dia_inteiro, link = excluded.link,
      cancelado = false,
      atualizado_em = case when (compromisso.titulo, compromisso.descricao, compromisso.local, compromisso.inicio, compromisso.fim,
                                 compromisso.dia_inteiro, compromisso.link, compromisso.cancelado)
                                is distinct from (excluded.titulo, excluded.descricao, excluded.local, excluded.inicio, excluded.fim,
                                                  excluded.dia_inteiro, excluded.link, false)
                           then now() else compromisso.atualizado_em end
    returning externo_id
  )
  select array_agg(externo_id), count(*) into v_ids, v_upsert from up;

  update compromisso set cancelado = true, atualizado_em = now()
   where origem = 'google' and not cancelado and inicio >= p_de and inicio < p_ate
     and not (externo_id = any (coalesce(v_ids, '{}')));
  get diagnostics v_cancel = row_count;

  return jsonb_build_object('ok', true, 'recebidos', v_upsert, 'cancelados', v_cancel);
end $$;

revoke all on function jarvis.sincronizar_agenda(jsonb, timestamptz, timestamptz) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'neo_n8n') then
    grant usage on schema jarvis to neo_n8n;
    grant execute on function jarvis.sincronizar_agenda(jsonb, timestamptz, timestamptz) to neo_n8n;
  end if;
end $$;
