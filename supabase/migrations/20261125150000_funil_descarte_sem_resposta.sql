-- Funil: descarte automático de quem não responde (demanda "funil", 25/11).
-- Oportunidade abordada (ou que respondeu e depois sumiu) sem nenhuma resposta da empresa há
-- neo.config.descarte_sem_resposta_dias (padrão 14; 0 desliga) sai do funil como 'descartada'.
-- * conta a partir da última mensagem da empresa (respostas automáticas de WhatsApp Business não contam)
--   ou, se ela nunca respondeu, de quando entrou na etapa (etapa_desde);
-- * só 'abordada' e 'respondeu': reunião e proposta são etapas conduzidas por gente, não mexe;
-- * marca responsavel = 'descarte_auto' (aparece no histórico de etapas) e registra uma interação de controle;
-- * se a empresa responder depois, a oportunidade volta para 'respondeu' (trigger em interacao),
--   a não ser que tenha pedido para não receber mensagens;
-- * roda dentro de neo.reservar (o n8n já chama), antes da checagem da janela de envio.

insert into neo.config (chave, valor, descricao) values
  ('descarte_sem_resposta_dias', '14', 'Dias sem resposta da empresa até a oportunidade abordada sair do funil como descartada (0 desliga)')
on conflict (chave) do nothing;

create or replace function neo.descartar_sem_resposta()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_dias int := coalesce(nullif(neo._cfg('descarte_sem_resposta_dias'), '')::int, 14);
  v_n int;
begin
  if v_dias <= 0 then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('neo.descartar_sem_resposta'));

  with paradas as (
    select o.id
      from public.oportunidade o
     where o.status in ('abordada', 'respondeu')
       and greatest(o.etapa_desde,
                    coalesce((select max(i.registrado_em) from public.interacao i
                               where i.oportunidade_id = o.id and i.direcao = 'entrada'
                                 and i.resumo not like '[Resposta automática%'), '-infinity'::timestamptz))
           < now() - make_interval(days => v_dias)
  ), feitas as (
    update public.oportunidade o set status = 'descartada', responsavel = 'descarte_auto'
      from paradas p where o.id = p.id
    returning o.id
  )
  insert into public.interacao (oportunidade_id, canal, direcao, resumo, registrado_por, resultado)
  select f.id, 'outro', 'saida',
         'Descartada automaticamente: ' || v_dias || ' dias sem resposta da empresa.', 'neo', 'descarte_auto'
    from feitas f;
  get diagnostics v_n = row_count;
  return v_n;
end $function$;

revoke all on function neo.descartar_sem_resposta() from public;

-- Respondeu depois do descarte automático: volta para o funil.
create or replace function public.reabrir_descartada() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.direcao = 'entrada' and new.resumo not like '[Resposta automática%' then
    update public.oportunidade o set status = 'respondeu', responsavel = 'neo'
     where o.id = new.oportunidade_id and o.status = 'descartada' and o.responsavel = 'descarte_auto'
       and not neo._bloqueada(o.empresa_id);
  end if;
  return null;
end $$;

drop trigger if exists interacao_reabrir_descartada on public.interacao;
create trigger interacao_reabrir_descartada after insert on public.interacao
  for each row execute function public.reabrir_descartada();

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

  -- quem não responde há N dias sai do funil (roda mesmo fora da janela de envio)
  perform neo.descartar_sem_resposta();

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

