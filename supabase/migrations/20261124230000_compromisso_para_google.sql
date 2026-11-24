-- Painel → Google Agenda (demanda "Sincronizar compromissos do painel com Google Agenda", 24/11).
-- O n8n (workflow "Painel IONEXT → Google Agenda", a cada 2 min, usuário neo_n8n) pede a fila com
-- jarvis.compromissos_para_google(), cria/atualiza/apaga o evento no Google e devolve o resultado
-- com jarvis.marcar_compromisso_google(). O id do evento no Google é o próprio id do compromisso sem hífens
-- (hex é válido no Google), então criar de novo é idempotente e a sincronização Google → painel
-- (jarvis.sincronizar_agenda) reconhece e ignora esses eventos, sem duplicar o compromisso.

alter table public.compromisso
  add column if not exists google_evento_id text,          -- preenchido quando o evento existe no Google
  add column if not exists google_versao timestamptz,      -- atualizado_em que já foi enviado ao Google
  add column if not exists google_tentativas int not null default 0,
  add column if not exists google_erro text;

create index if not exists compromisso_google_pendente_idx on public.compromisso (atualizado_em)
  where origem = 'painel';

-- Fila do que precisa ir para o Google (no máximo 50 por vez, com até 5 tentativas por versão).
-- acao: criar | atualizar | apagar. Já devolve o corpo do evento no formato da API do Google Calendar.
create or replace function jarvis.compromissos_para_google()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with fila as (
    select c.*, e.nome_fantasia as empresa_nome,
           case when c.cancelado then 'apagar' when c.google_evento_id is null then 'criar' else 'atualizar' end as acao,
           (c.inicio at time zone 'America/Sao_Paulo')::date as dia_ini
      from compromisso c left join empresa e on e.id = c.empresa_id
     where c.origem = 'painel'
       and c.google_tentativas < 5
       and (c.google_versao is null or date_trunc('milliseconds', c.atualizado_em) > c.google_versao)
       and (
         -- novo: só o que ainda não passou (até 35 dias atrás, a mesma janela da busca no Google)
         (c.google_evento_id is null and not c.cancelado and coalesce(c.fim, c.inicio) >= now() - interval '35 days')
         or c.google_evento_id is not null
       )
     order by c.atualizado_em
     limit 50
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'compromisso_id', f.id,
    'versao', date_trunc('milliseconds', f.atualizado_em),  -- ms: o valor passa por JavaScript (n8n)
    'acao', f.acao,
    'evento_id', coalesce(f.google_evento_id, replace(f.id::text, '-', '')),
    'evento', case when f.acao = 'apagar' then null else jsonb_strip_nulls(jsonb_build_object(
      'id', case when f.acao = 'criar' then replace(f.id::text, '-', '') end,
      'summary', f.titulo,
      'location', f.local,
      'description', nullif(concat_ws(E'\n\n',
          f.descricao,
          case when f.empresa_nome is not null then 'Empresa: ' || f.empresa_nome end,
          case when f.link is not null then 'Link: ' || f.link end,
          'Criado no painel IONEXT (para mudar ou tirar, use o painel).'), ''),
      'start', case when f.dia_inteiro
                    then jsonb_build_object('date', to_char(f.dia_ini, 'YYYY-MM-DD'))
                    else jsonb_build_object('dateTime', to_char(f.inicio at time zone 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI:SS') || '-03:00',
                                            'timeZone', 'America/Sao_Paulo') end,
      'end',   case when f.dia_inteiro
                    -- no Google o fim de dia inteiro é exclusivo (dia seguinte)
                    then jsonb_build_object('date', to_char(greatest(f.dia_ini + 1,
                           coalesce((f.fim at time zone 'America/Sao_Paulo')::date, f.dia_ini + 1)), 'YYYY-MM-DD'))
                    else jsonb_build_object('dateTime', to_char(coalesce(f.fim, f.inicio + interval '1 hour') at time zone 'America/Sao_Paulo',
                                            'YYYY-MM-DD"T"HH24:MI:SS') || '-03:00', 'timeZone', 'America/Sao_Paulo') end,
      'source', case when f.link is not null then jsonb_build_object('title', 'Link do compromisso', 'url', f.link) end
    )) end
  ) order by f.atualizado_em), '[]'::jsonb)
  from fila f
$$;

-- Resultado de um envio. p_ok=true: p_evento_id é o id no Google (ou null se o evento foi apagado).
-- p_versao é o atualizado_em lido na fila: se o compromisso mudou no meio, a nova versão volta para a fila.
create or replace function jarvis.marcar_compromisso_google(p_compromisso_id uuid, p_versao timestamptz, p_ok boolean,
                                                            p_evento_id text default null, p_erro text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v int;
begin
  if p_ok then
    update compromisso set google_evento_id = left(nullif(btrim(p_evento_id), ''), 300),
                           google_versao = date_trunc('milliseconds', p_versao), google_tentativas = 0, google_erro = null
     where id = p_compromisso_id and origem = 'painel';
  else
    update compromisso set google_tentativas = google_tentativas + 1, google_erro = left(p_erro, 1000)
     where id = p_compromisso_id and origem = 'painel';
  end if;
  get diagnostics v = row_count;
  return jsonb_build_object('ok', v = 1);
end $$;

-- Toda edição no painel conta como versão nova: zera as tentativas para tentar de novo.
create or replace function public.compromisso_zera_tentativas_google()
returns trigger language plpgsql as $$
begin
  if new.atualizado_em is distinct from old.atualizado_em then new.google_tentativas := 0; new.google_erro := null; end if;
  return new;
end $$;
drop trigger if exists compromisso_zera_tentativas_google on public.compromisso;
create trigger compromisso_zera_tentativas_google before update on public.compromisso
  for each row when (new.origem = 'painel') execute function public.compromisso_zera_tentativas_google();

-- Google → painel: ignora os eventos que nasceram no painel (id = id do compromisso sem hífens).
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
       and not exists (select 1 from compromisso p
                        where p.origem = 'painel'
                          and (p.google_evento_id = btrim(e->>'id') or replace(p.id::text, '-', '') = btrim(e->>'id')))
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

revoke all on function jarvis.compromissos_para_google() from public;
revoke all on function jarvis.marcar_compromisso_google(uuid, timestamptz, boolean, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'neo_n8n') then
    grant usage on schema jarvis to neo_n8n;
    grant execute on function jarvis.compromissos_para_google() to neo_n8n;
    grant execute on function jarvis.marcar_compromisso_google(uuid, timestamptz, boolean, text, text) to neo_n8n;
  end if;
end $$;
