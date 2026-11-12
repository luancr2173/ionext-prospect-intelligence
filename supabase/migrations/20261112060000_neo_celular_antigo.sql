-- Celulares no formato antigo (8 dígitos começando com 6–9, antes do nono dígito) ainda aparecem na Receita.
-- A Anatel acrescentou o 9 na frente de todos os celulares; a conversão é determinística.
-- O fluxo do n8n confere na Evolution se o número convertido tem WhatsApp antes de enviar.
create or replace function neo._whatsapp(p_empresa_id uuid) returns table (numero text, fonte text)
language sql stable security definer set search_path = '' as $$
  select case when c.valor_normalizado ~ '^\+55\d{2}9\d{8}$' then c.valor_normalizado
              else substr(c.valor_normalizado, 1, 5) || '9' || substr(c.valor_normalizado, 6) end,
         coalesce(ev.fonte, 'desconhecida')
           || case when c.valor_normalizado ~ '^\+55\d{2}9\d{8}$' then '' else ' (convertido do formato antigo: +9)' end
    from public.contato c left join public.evidencia ev on ev.id = c.evidencia_id
   where c.empresa_id = p_empresa_id and c.publico_comercial
     and c.tipo in ('whatsapp', 'telefone')
     and (c.valor_normalizado ~ '^\+55\d{2}9\d{8}$' or c.valor_normalizado ~ '^\+55\d{2}[6-9]\d{7}$')
   order by (c.tipo = 'whatsapp') desc, (c.valor_normalizado ~ '^\+55\d{2}9\d{8}$') desc, c.criado_em
   limit 1
$$;
revoke all on function neo._whatsapp(uuid) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function neo._whatsapp(uuid) from %I', r);
    end if;
  end loop;
end $$;

/** Número sem WhatsApp (conferido na Evolution): cancela o envio sem gastar cota e não tenta de novo. */
create or replace function neo.registrar_sem_whatsapp(p_envio_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v neo.envio;
begin
  update neo.envio set status = 'cancelado', erro = 'número sem WhatsApp'
   where id = p_envio_id and status = 'reservado' returning * into v;
  if v.id is null then return jsonb_build_object('ok', false); end if;
  if not v.teste then
    insert into public.interacao (oportunidade_id, canal, direcao, resumo, registrado_por)
    values (v.oportunidade_id, 'whatsapp', 'saida', 'Número ' || v.telefone || ' não tem WhatsApp; não abordado.', 'neo');
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function neo.registrar_sem_whatsapp(uuid) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function neo.registrar_sem_whatsapp(uuid) from %I', r);
    end if;
  end loop;
end $$;
grant execute on function neo.registrar_sem_whatsapp(uuid) to neo_n8n;

-- reservar: não repete número sem WhatsApp nem insiste em oportunidade que falhou 3 vezes
create or replace function neo.reservar(p_limite int default 3)
returns table (envio_id uuid, oportunidade_id uuid, tipo text, telefone text, destino text, teste boolean,
               instancia text, contexto jsonb, mensagem_anterior text)
language plpgsql security definer set search_path = '' as $$
declare
  v_agora timestamptz := now();
  v_local timestamp := now() at time zone 'America/Sao_Paulo';
  v_teste boolean := coalesce(neo._cfg('modo_teste'), 'true') = 'true';
  v_numero_teste text := neo._normalizar(neo._cfg('numero_teste'));
  v_restante int;
  v_followup int := coalesce(neo._cfg('followup_dias')::int, 3);
begin
  -- reservas abandonadas (n8n caiu no meio) voltam
  update neo.envio set status = 'cancelado', erro = 'reserva expirada'
   where status = 'reservado' and reservado_em < v_agora - interval '1 hour';

  if not (extract(isodow from v_local)::text = any (string_to_array(neo._cfg('dias_semana'), ','))) then return; end if;
  if extract(hour from v_local) < neo._cfg('hora_inicio')::int or extract(hour from v_local) >= neo._cfg('hora_fim')::int then return; end if;
  if v_teste and v_numero_teste is null then
    raise exception 'modo_teste ligado sem numero_teste válido em neo.config';
  end if;

  select neo._cfg('limite_diario')::int - count(*) into v_restante from neo.envio e
   where e.status in ('reservado', 'enviado') and e.teste = v_teste
     and (e.reservado_em at time zone 'America/Sao_Paulo')::date = v_local::date;
  if v_restante <= 0 then return; end if;

  return query
  with candidatos as (
    -- primeira mensagem: aprovadas, sem envio ainda (no modo atual), não bloqueadas, com celular
    select o.id as op_id, 'primeira'::text as tp, w.numero, null::text as anterior, o.atualizado_em as ordem
      from public.oportunidade o
      cross join lateral neo._whatsapp(o.empresa_id) w
     where o.status = 'aprovada_para_contato'
       and not neo._bloqueada(o.empresa_id)
       and not exists (select 1 from neo.envio x where x.oportunidade_id = o.id and x.tipo = 'primeira'
                          and x.teste = v_teste and x.status in ('reservado', 'enviado'))
       -- número que a Evolution disse não ter WhatsApp não volta para a fila
       and not exists (select 1 from neo.envio z where z.telefone = w.numero and z.erro = 'número sem WhatsApp')
       -- no máximo 3 tentativas que falharam (mensagem recusada pela validação ou erro de envio)
       and (select count(*) from neo.envio z where z.oportunidade_id = o.id and z.status = 'falhou' and z.teste = v_teste) < 3
    union all
    -- follow-up: primeira enviada há N dias, ainda sem resposta, sem follow-up
    select o.id, 'followup', x.telefone, x.mensagem, x.enviado_em
      from neo.envio x
      join public.oportunidade o on o.id = x.oportunidade_id
     where v_followup > 0 and x.tipo = 'primeira' and x.status = 'enviado' and x.teste = v_teste
       and x.enviado_em < v_agora - make_interval(days => v_followup)
       and (v_teste or o.status = 'abordada')
       and not neo._bloqueada(o.empresa_id)
       and (select count(*) from neo.envio z where z.oportunidade_id = o.id and z.tipo = 'followup'
             and z.status = 'falhou' and z.teste = v_teste) < 3
       and not exists (select 1 from neo.envio y where y.oportunidade_id = o.id and y.tipo = 'followup'
                          and y.teste = v_teste and y.status in ('reservado', 'enviado'))
  ),
  escolhidos as (
    select c.* from candidatos c order by (c.tp = 'followup') desc, c.ordem limit least(p_limite, v_restante)
  ),
  inseridos as (
    insert into neo.envio (oportunidade_id, tipo, telefone, destino, teste)
    select e.op_id, e.tp, e.numero, case when v_teste then v_numero_teste else e.numero end, v_teste
      from escolhidos e
    on conflict do nothing
    returning neo.envio.id, neo.envio.oportunidade_id, neo.envio.tipo, neo.envio.telefone, neo.envio.destino
  )
  select i.id, i.oportunidade_id, i.tipo, i.telefone, i.destino, v_teste, neo._cfg('instancia'),
         neo.montar_contexto(i.oportunidade_id),
         (select e.anterior from escolhidos e where e.op_id = i.oportunidade_id and e.tp = i.tipo limit 1)
    from inseridos i;
end $$;

revoke all on function neo.reservar(int) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function neo.reservar(int) from %I', r);
    end if;
  end loop;
end $$;
grant execute on function neo.reservar(int) to neo_n8n;
