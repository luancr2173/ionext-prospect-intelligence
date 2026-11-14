-- Controle da conversa do Neo pelo CRM:
--   1. as respostas que o Neo dá durante o atendimento ficam registradas na linha do tempo;
--   2. "assumir a conversa": uma pessoa pausa o Neo para aquela empresa (ele para de responder
--      e de mandar follow-up) até devolver a conversa;
--   3. opt-out duvidoso ("agora não", "mais pra frente") continua bloqueando na hora, mas entra
--      numa fila para uma pessoa confirmar ou desfazer.

alter table public.oportunidade
  add column if not exists neo_pausado_em timestamptz,
  add column if not exists neo_pausado_por text;

alter table public.opt_out
  add column if not exists revisao text,
  add column if not exists mensagem text,
  add column if not exists oportunidade_id uuid references public.oportunidade(id) on delete set null;
do $$ begin
  alter table public.opt_out add constraint opt_out_revisao_ck check (revisao is null or revisao in ('pendente', 'confirmado'));
exception when duplicate_object then null; end $$;
create index if not exists opt_out_revisao_idx on public.opt_out (registrado_em) where revisao = 'pendente';

/** Envio de prospecção que originou a conversa com este número (real; no teste, o último envio de teste
 *  para o numero_teste nos últimos 7 dias). */
create or replace function neo._envio_da_conversa(p_telefone text) returns neo.envio
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select e from neo.envio e where e.status = 'enviado' and not e.teste and e.telefone = neo._normalizar(p_telefone)
      order by e.enviado_em desc limit 1),
    (select e from neo.envio e where e.status = 'enviado' and e.teste and e.destino = neo._normalizar(p_telefone)
        and e.enviado_em > now() - interval '7 days'
      order by e.enviado_em desc limit 1))
$$;

/** Quando alguém responde: diz se veio da prospecção, devolve o contexto, registra a resposta,
 *  reconhece opt-out (duvidoso vai para revisão) e avisa se uma pessoa assumiu a conversa. */
create or replace function neo.ao_receber(p_telefone text, p_mensagem text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tel text := neo._normalizar(p_telefone);
  v_x neo.envio;
  v_optout boolean;
  v_duvida boolean;
  v_pausado boolean := false;
  v_msg text := lower(coalesce(p_mensagem, ''));
begin
  if v_tel is null then return jsonb_build_object('prospeccao', false); end if;
  v_x := neo._envio_da_conversa(v_tel);
  if v_x.id is null then return jsonb_build_object('prospeccao', false); end if;

  v_optout := v_msg ~
    '(n[aã]o (quero|tenho interesse|me (mande|envie|chame))|pare de|para de (me )?(mandar|enviar)|n[aã]o (mande|envie) mais|remov|descadastr|sair da lista|sem interesse|bloque)';
  -- "agora não", "no momento", "mais pra frente"...: pode ser só adiamento, uma pessoa confere
  v_duvida := v_optout and v_msg ~
    '(agora|no momento|por enquanto|neste momento|nesse momento|mais (pra|para) frente|futuramente|depois|outra hora|ano que vem|pr[oó]ximo (m[eê]s|ano)|ainda n[aã]o)';

  if not v_x.teste then
    if v_optout then
      perform neo.registrar_opt_out(v_tel, 'pediu pelo WhatsApp: ' || left(p_mensagem, 200));
      update public.opt_out set revisao = case when v_duvida then 'pendente' else 'confirmado' end,
                                mensagem = left(p_mensagem, 1000), oportunidade_id = v_x.oportunidade_id
       where chave = 'telefone' and valor = v_tel and revisao is null;
    else
      update public.oportunidade set status = 'respondeu' where id = v_x.oportunidade_id and status = 'abordada';
    end if;
    insert into public.interacao (oportunidade_id, canal, direcao, resumo, registrado_por)
    values (v_x.oportunidade_id, 'whatsapp', 'entrada', left(coalesce(p_mensagem, ''), 1500), 'neo');
  end if;
  select o.neo_pausado_em is not null into v_pausado from public.oportunidade o where o.id = v_x.oportunidade_id;

  return jsonb_build_object(
    'prospeccao', true,
    'teste', v_x.teste,
    'pausado', coalesce(v_pausado, false),
    'pediu_para_nao_receber', v_optout,
    'primeira_mensagem', v_x.mensagem,
    'enviado_em', v_x.enviado_em,
    'contexto', neo.montar_contexto(v_x.oportunidade_id));
end $$;

/** Resposta que o Neo deu na conversa (fluxo de atendimento). Só para conversas da prospecção, fora do teste. */
create or replace function neo.registrar_resposta_neo(p_telefone text, p_texto text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_x neo.envio := neo._envio_da_conversa(p_telefone);
        v_texto text := btrim(regexp_replace(coalesce(p_texto, ''), '\\+', E'\n', 'g'));
begin
  if v_x.id is null or v_x.teste or v_texto = '' then return jsonb_build_object('ok', false); end if;
  insert into public.interacao (oportunidade_id, canal, direcao, resumo, registrado_por)
  values (v_x.oportunidade_id, 'whatsapp', 'saida', 'Neo: ' || left(v_texto, 1500), 'neo');
  return jsonb_build_object('ok', true);
end $$;

/** O Neo pode mandar mensagem para este número agora? Não, se uma pessoa assumiu a conversa
 *  ou se o número pediu para não receber. Números fora da prospecção: sim. */
create or replace function neo.pode_responder(p_telefone text)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v_x neo.envio := neo._envio_da_conversa(p_telefone);
begin
  if exists (select 1 from public.opt_out o where o.chave = 'telefone' and o.valor = neo._normalizar(p_telefone)) then return false; end if;
  if v_x.id is null then return true; end if;
  return not exists (select 1 from public.oportunidade o where o.id = v_x.oportunidade_id and o.neo_pausado_em is not null);
end $$;

revoke all on function neo._envio_da_conversa(text), neo.ao_receber(text, text), neo.registrar_resposta_neo(text, text),
  neo.pode_responder(text) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function neo._envio_da_conversa(text), neo.ao_receber(text, text), neo.registrar_resposta_neo(text, text), neo.pode_responder(text) from %I', r);
    end if;
  end loop;
end $$;
grant execute on function neo.ao_receber(text, text), neo.registrar_resposta_neo(text, text), neo.pode_responder(text) to neo_n8n;

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

  if not neo._janela_aberta(v_local) then return; end if;
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
       and o.neo_pausado_em is null
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
       and o.neo_pausado_em is null
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

