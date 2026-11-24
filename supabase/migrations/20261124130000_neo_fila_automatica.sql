-- Fila automática do Neo (demanda "prospecção", 24/11): oportunidades do funil em "A revisar"
-- (status nova ou revisada) que têm oferta entram sozinhas na fila do Neo (aprovada_para_contato),
-- aos poucos: no máximo neo.config.fila_auto_diaria por dia (padrão 10; 0 desliga).
-- * neo.promover_para_fila: escolhe as melhores (lead score), só as que o Neo consegue abordar de fato
--   (celular/WhatsApp válido, sem opt-out, sem pausa, empresa ainda não abordada nem já na fila);
--   quem já esteve na fila e saiu (tirada no painel ou devolvida pelo Neo) não volta sozinha;
-- * roda dentro de neo.reservar (que o n8n chama na janela de envio), então não precisa de agendador;
-- * no modo teste não promove nada (o modo teste não mexe no funil);
-- * a contagem do dia vem do histórico de etapas (por = 'neo_auto'), então chamar várias vezes não passa do limite.

insert into neo.config (chave, valor, descricao) values
  ('fila_auto_diaria', '10', 'Quantas oportunidades "A revisar" com oferta entram sozinhas na fila do Neo por dia (0 desliga)')
on conflict (chave) do nothing;

create or replace function neo.promover_para_fila()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_local timestamp := now() at time zone 'America/Sao_Paulo';
  v_limite int := coalesce(nullif(neo._cfg('fila_auto_diaria'), '')::int, 10);
  v_feitas int;
  v_n int;
begin
  if v_limite <= 0 then return 0; end if;
  if coalesce(neo._cfg('modo_teste'), 'true') = 'true' then return 0; end if;
  -- duas chamadas ao mesmo tempo não promovem em dobro
  perform pg_advisory_xact_lock(hashtext('neo.promover_para_fila'));

  select count(*) into v_feitas from public.oportunidade_etapa h
   where h.para = 'aprovada_para_contato' and h.por = 'neo_auto'
     and (h.em at time zone 'America/Sao_Paulo')::date = v_local::date;
  if v_feitas >= v_limite then return 0; end if;

  with candidatas as (
    select distinct on (o.empresa_id) o.id, o.lead_score, o.prioridade, o.criado_em
      from public.oportunidade o
     where o.status in ('nova', 'revisada')
       and o.neo_pausado_em is null
       and public.oferta_da_oportunidade(o.id) is not null
       and exists (select 1 from neo._whatsapp(o.empresa_id))
       and not neo._bloqueada(o.empresa_id)
       -- a empresa não tem outra oportunidade já na fila ou em conversa
       and not exists (select 1 from public.oportunidade o2
                        where o2.empresa_id = o.empresa_id and o2.id <> o.id
                          and o2.status in ('aprovada_para_contato', 'abordada', 'respondeu', 'reuniao', 'proposta', 'ganha'))
       -- já esteve na fila e saiu (tirada no painel ou devolvida pelo Neo): não volta sozinha
       and not exists (select 1 from public.oportunidade_etapa h where h.oportunidade_id = o.id and h.de = 'aprovada_para_contato')
       -- e nunca recebeu a primeira mensagem do Neo
       and not exists (select 1 from neo.envio x join public.oportunidade o3 on o3.id = x.oportunidade_id
                        where o3.empresa_id = o.empresa_id and x.tipo = 'primeira' and not x.teste
                          and x.status in ('reservado', 'enviado'))
     order by o.empresa_id, o.lead_score desc nulls last, o.criado_em
  ), escolhidas as (
    select c.id from candidatas c
     order by c.lead_score desc nulls last,
              case c.prioridade when 'alta' then 0 when 'media' then 1 else 2 end, c.criado_em
     limit v_limite - v_feitas
  )
  update public.oportunidade o set status = 'aprovada_para_contato', responsavel = 'neo_auto'
    from escolhidas e where o.id = e.id;
  get diagnostics v_n = row_count;
  return v_n;
end $function$;

revoke all on function neo.promover_para_fila() from public;

create or replace function neo.reservar(p_limite integer DEFAULT 3)
 RETURNS TABLE(envio_id uuid, oportunidade_id uuid, tipo text, telefone text, destino text, teste boolean, instancia text, contexto jsonb, mensagem_anterior text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- "A revisar" com oferta entra sozinha na fila, até fila_auto_diaria por dia
  perform neo.promover_para_fila();

  select neo._cfg('limite_diario')::int - count(*) into v_restante from neo.envio e
   where e.status in ('reservado', 'enviado') and e.teste = v_teste
     and (e.reservado_em at time zone 'America/Sao_Paulo')::date = v_local::date;
  if v_restante <= 0 then return; end if;

  return query
  with candidatos as (
    -- primeira mensagem: aprovadas (qualquer tipo: A, B, C ou D), sem envio ainda (no modo atual), não bloqueadas, com celular
    select o.empresa_id as emp, o.id as op_id, 'primeira'::text as tp, w.numero, null::text as anterior, o.atualizado_em as ordem,
           (select count(*) from neo.envio z where z.oportunidade_id = o.id and z.status = 'falhou' and z.teste = v_teste) as falhas
      from public.oportunidade o
      cross join lateral neo._whatsapp(o.empresa_id) w
     where o.status = 'aprovada_para_contato'
       and o.neo_pausado_em is null
       and not neo._bloqueada(o.empresa_id)
       and not exists (select 1 from neo.envio x where x.oportunidade_id = o.id and x.tipo = 'primeira'
                          and x.teste = v_teste and x.status in ('reservado', 'enviado'))
       -- uma empresa recebe só UMA abordagem, mesmo com duas oportunidades aprovadas (ex.: A e D)
       and not exists (select 1 from neo.envio x join public.oportunidade o2 on o2.id = x.oportunidade_id
                        where o2.empresa_id = o.empresa_id and x.tipo = 'primeira'
                          and x.teste = v_teste and x.status in ('reservado', 'enviado'))
       -- número que a Evolution disse não ter WhatsApp não volta para a fila
       and not exists (select 1 from neo.envio z where z.telefone = w.numero and z.erro = 'número sem WhatsApp')
       -- no máximo 3 tentativas que falharam (mensagem recusada pela validação ou erro de envio)
       and (select count(*) from neo.envio z where z.oportunidade_id = o.id and z.status = 'falhou' and z.teste = v_teste) < 3
    union all
    -- follow-up: primeira enviada há N dias, ainda sem resposta, sem follow-up
    select o.empresa_id, o.id, 'followup', x.telefone, x.mensagem, x.enviado_em,
           (select count(*) from neo.envio z where z.oportunidade_id = o.id and z.tipo = 'followup' and z.status = 'falhou' and z.teste = v_teste)
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
    -- quem falhou vai para o fim da fila: um follow-up recusado pela validação não segura as primeiras mensagens
    -- no máximo um envio por empresa em cada rodada
    select c.* from (select c1.*, row_number() over (partition by c1.tp order by c1.ordem) as vez
                       from (select distinct on (c0.emp) c0.* from candidatos c0
                              order by c0.emp, (c0.tp = 'followup') desc, c0.falhas, c0.ordem) c1) c
     -- alterna follow-up e primeira mensagem, para nenhum dos dois ficar parado
     order by c.falhas, c.vez, (c.tp = 'followup') desc, c.ordem limit least(p_limite, v_restante)
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
end $function$;
