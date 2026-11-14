-- Motor 02 · auditoria de sites: fila de pedidos e campos do relatório.
-- A fila fica na Central (o motor pede trabalho pela API e devolve o diagnóstico): os motores não se conhecem.

create table if not exists public.auditoria_pedido (
  empresa_id        uuid primary key references public.empresa(id) on delete cascade,
  url               text not null,
  motivo            text not null default 'novo' check (motivo in ('novo', 'reauditoria', 'manual')),
  pedido_em         timestamptz not null default now(),
  reservado_em      timestamptz,
  tentativas        int not null default 0,
  proxima_tentativa timestamptz not null default now(),
  ultimo_erro       text
);
create index if not exists auditoria_pedido_proxima_idx on public.auditoria_pedido (proxima_tentativa);
alter table public.auditoria_pedido enable row level security;

alter table public.auditoria
  add column if not exists url_final text,
  add column if not exists resumo text,
  add column if not exists servicos_recomendados text[] not null default '{}',
  add column if not exists paginas jsonb not null default '[]'::jsonb;

-- O Neo ainda só sabe falar com quem não tem site (oportunidade A): B/C/D não entram na fila dele
-- até o Neo ser adaptado para reformulação (decisão de 14/11/2026).
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
    -- primeira mensagem: aprovadas, oportunidade A, sem envio ainda (no modo atual), não bloqueadas, com celular
    select o.id as op_id, 'primeira'::text as tp, w.numero, null::text as anterior, o.atualizado_em as ordem
      from public.oportunidade o
      cross join lateral neo._whatsapp(o.empresa_id) w
     where o.status = 'aprovada_para_contato'
       and o.tipo = 'A'
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
