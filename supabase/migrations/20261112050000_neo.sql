-- Fase 5 — integração com o agente Neo (n8n).
-- O n8n conecta com o usuário neo_n8n, que SÓ pode executar as funções do schema neo
-- (nenhum acesso direto a tabelas). Regras de horário, cota diária, opt-out, canal e modo teste
-- ficam aqui, no banco: o fluxo do n8n não consegue contorná-las.

create schema if not exists neo;

-- ------------------------------------------------------------------ configuração
create table neo.config (
  chave text primary key,
  valor text not null,
  descricao text
);
insert into neo.config (chave, valor, descricao) values
  ('modo_teste',     'true', 'true = todas as mensagens vão para numero_teste e nada muda no funil'),
  ('numero_teste',   '',     'Celular que recebe as mensagens no modo teste (E.164, ex.: +5561999999999)'),
  ('limite_diario',  '15',   'Máximo de mensagens (primeira + follow-up) por dia'),
  ('hora_inicio',    '9',    'Início da janela de envio (horário de Brasília)'),
  ('hora_fim',       '18',   'Fim da janela de envio (horário de Brasília, exclusivo)'),
  ('dias_semana',    '1,2,3,4,5', 'Dias permitidos (1 = segunda ... 7 = domingo)'),
  ('followup_dias',  '3',    'Dias sem resposta até o follow-up (0 desliga o follow-up)'),
  ('instancia',      'TESTE','Instância da Evolution API usada no envio');

-- ------------------------------------------------------------------ envios
create table neo.envio (
  id              uuid primary key default gen_random_uuid(),
  oportunidade_id uuid not null references public.oportunidade(id) on delete cascade,
  tipo            text not null check (tipo in ('primeira', 'followup')),
  telefone        text not null,           -- número real da empresa (E.164)
  destino         text not null,           -- para onde foi de fato (no teste, o numero_teste)
  teste           boolean not null,
  status          text not null default 'reservado' check (status in ('reservado', 'enviado', 'falhou', 'cancelado')),
  mensagem        text,
  erro            text,
  reservado_em    timestamptz not null default now(),
  enviado_em      timestamptz
);
create index envio_oportunidade_idx on neo.envio (oportunidade_id, tipo);
create index envio_telefone_idx on neo.envio (telefone, enviado_em desc);
create unique index envio_unico_real on neo.envio (oportunidade_id, tipo) where not teste and status in ('reservado', 'enviado');
create unique index envio_unico_teste on neo.envio (oportunidade_id, tipo) where teste and status in ('reservado', 'enviado');

alter table neo.config enable row level security;
alter table neo.envio enable row level security;

-- ------------------------------------------------------------------ utilidades
create or replace function neo._cfg(p_chave text) returns text
language sql stable security definer set search_path = '' as $$
  select valor from neo.config where chave = p_chave
$$;

/** Só dígitos com +55 na frente, para comparar números vindos do WhatsApp (5561999999999@s.whatsapp.net). */
create or replace function neo._normalizar(p_telefone text) returns text
language sql immutable set search_path = '' as $$
  select case
    when d ~ '^55\d{10,11}$' then '+' || d
    when d ~ '^\d{10,11}$' then '+55' || d
    else null end
  from (select regexp_replace(split_part(coalesce(p_telefone, ''), '@', 1), '\D', '', 'g') as d) x
$$;

/** Melhor número de WhatsApp da empresa: whatsapp publicado; senão celular comercial (fixo não tem WhatsApp). */
create or replace function neo._whatsapp(p_empresa_id uuid) returns table (numero text, fonte text)
language sql stable security definer set search_path = '' as $$
  select c.valor_normalizado, coalesce(ev.fonte, 'desconhecida')
    from public.contato c left join public.evidencia ev on ev.id = c.evidencia_id
   where c.empresa_id = p_empresa_id and c.publico_comercial
     and c.tipo in ('whatsapp', 'telefone')
     and c.valor_normalizado ~ '^\+55\d{2}9\d{8}$'
   order by (c.tipo = 'whatsapp') desc, c.criado_em
   limit 1
$$;

/** Empresa bloqueada por opt-out (CNPJ, telefone, e-mail ou domínio)? */
create or replace function neo._bloqueada(p_empresa_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.opt_out o
     where (o.chave = 'cnpj' and o.valor = (select cnpj from public.empresa where id = p_empresa_id))
        or (o.chave = 'telefone' and exists (select 1 from public.contato c where c.empresa_id = p_empresa_id
                                              and c.tipo <> 'email' and c.valor_normalizado = o.valor))
        or (o.chave = 'email' and exists (select 1 from public.contato c where c.empresa_id = p_empresa_id
                                           and c.tipo = 'email' and c.valor_normalizado = o.valor))
        or (o.chave = 'dominio' and exists (select 1 from public.contato c where c.empresa_id = p_empresa_id
                                             and c.tipo = 'email' and split_part(c.valor_normalizado, '@', 2) = o.valor)))
$$;

/** Contexto que o Neo recebe: só dados verificados da ficha, com a fonte. */
create or replace function neo.montar_contexto(p_oportunidade_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'empresa', jsonb_build_object(
      'nome', e.nome_fantasia,
      'segmento', case e.segmento
        when 'clinica_odontologica' then 'clínica odontológica' when 'clinica_medica' then 'clínica médica'
        when 'academia' then 'academia' when 'restaurante' then 'restaurante' when 'beleza' then 'salão/barbearia'
        when 'oficina_mecanica' then 'oficina mecânica' when 'construcao_civil' then 'construtora'
        when 'imobiliaria' then 'imobiliária' when 'contabilidade' then 'escritório de contabilidade'
        else e.segmento end,
      'bairro', e.bairro, 'cidade', e.cidade,
      'anos_de_operacao', case when e.data_abertura is not null
        then extract(year from age(now(), e.data_abertura))::int end),
    'diagnostico', jsonb_build_object(
      'presenca', p.classificacao,
      'resumo', case p.classificacao
        when 'SEM_SITE' then 'Não encontramos site próprio da empresa.'
        when 'SOMENTE_REDES' then 'A empresa atende pelas redes sociais e não encontramos site próprio.'
        when 'PRESENCA_FRACA' then 'A empresa tem domínio/site, mas ele não está funcionando bem.'
        else 'Presença digital a confirmar.' end,
      'site', p.url_site,
      'redes', coalesce((select jsonb_agg(c.valor order by c.tipo) from public.contato c
                          where c.empresa_id = e.id and c.tipo in ('instagram', 'facebook', 'linkedin')), '[]'::jsonb),
      'avaliacoes', (select jsonb_build_object('quantidade', ev.payload->'quantidade', 'nota', ev.payload->'nota')
                       from public.evidencia ev where ev.empresa_id = e.id and ev.fonte = 'manual'
                        and ev.payload->>'tipo' = 'avaliacoes' order by ev.coletado_em desc limit 1)),
    'oportunidade', jsonb_build_object(
      'tipo', o.tipo,
      'objetivo', case o.tipo when 'A' then 'primeiro site profissional + atendimento com IA no WhatsApp'
                              when 'B' then 'reformulação do site + atendimento com IA'
                              when 'C' then 'melhorias de desempenho e conversão no site'
                              else 'automação comercial e atendimento com IA' end,
      'servicos_sugeridos', to_jsonb(o.servicos_sugeridos),
      'lead_score', o.lead_score),
    'regras', jsonb_build_array(
      'Apresente-se como Neo, da IONEXT, e diga em uma frase por que está entrando em contato.',
      'Use apenas os fatos deste contexto. Não invente números, clientes, resultados, preços ou promessas.',
      'Seja consultivo e respeitoso: nunca diga que a empresa está mal, errada ou ultrapassada.',
      'Mensagem curta (até 4 frases), sem links e sem anexos.',
      'Termine com uma pergunta aberta e com a frase: "Se preferir não receber mensagens, é só me avisar."'))
  from public.oportunidade o
  join public.empresa e on e.id = o.empresa_id
  left join public.presenca_digital p on p.empresa_id = e.id
  where o.id = p_oportunidade_id
$$;

-- ------------------------------------------------------------------ API para o n8n
/**
 * Reserva os próximos envios (primeira mensagem e follow-up), respeitando janela, cota diária,
 * opt-out e canal. Chamada concorrente é segura (SKIP LOCKED + índices únicos).
 */
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
    union all
    -- follow-up: primeira enviada há N dias, ainda sem resposta, sem follow-up
    select o.id, 'followup', x.telefone, x.mensagem, x.enviado_em
      from neo.envio x
      join public.oportunidade o on o.id = x.oportunidade_id
     where v_followup > 0 and x.tipo = 'primeira' and x.status = 'enviado' and x.teste = v_teste
       and x.enviado_em < v_agora - make_interval(days => v_followup)
       and (v_teste or o.status = 'abordada')
       and not neo._bloqueada(o.empresa_id)
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

/** Registra o resultado do envio. Fora do modo teste, move a oportunidade para "abordada". */
create or replace function neo.registrar_envio(p_envio_id uuid, p_mensagem text, p_ok boolean, p_erro text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v neo.envio;
begin
  update neo.envio set status = case when p_ok then 'enviado' else 'falhou' end,
                       mensagem = p_mensagem, erro = p_erro, enviado_em = case when p_ok then now() end
   where id = p_envio_id and status = 'reservado'
  returning * into v;
  if v.id is null then return jsonb_build_object('ok', false, 'erro', 'envio não encontrado ou já registrado'); end if;
  if p_ok and not v.teste then
    update public.oportunidade set status = 'abordada', responsavel = 'neo'
     where id = v.oportunidade_id and status = 'aprovada_para_contato';
    insert into public.interacao (oportunidade_id, canal, direcao, resumo, registrado_por)
    values (v.oportunidade_id, 'whatsapp', 'saida',
            case v.tipo when 'primeira' then 'Primeira mensagem: ' else 'Follow-up: ' end || left(p_mensagem, 1500), 'neo');
  end if;
  return jsonb_build_object('ok', true, 'teste', v.teste);
end $$;

/** A empresa respondeu (chamado pelo fluxo de atendimento do Neo). Ignora números que não vieram da prospecção. */
create or replace function neo.registrar_resposta(p_telefone text, p_resumo text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tel text := neo._normalizar(p_telefone); v_op uuid;
begin
  select x.oportunidade_id into v_op from neo.envio x
   where x.telefone = v_tel and x.status = 'enviado' and not x.teste
   order by x.enviado_em desc limit 1;
  if v_op is null then return jsonb_build_object('prospeccao', false); end if;
  update public.oportunidade set status = 'respondeu' where id = v_op and status = 'abordada';
  insert into public.interacao (oportunidade_id, canal, direcao, resumo, registrado_por)
  values (v_op, 'whatsapp', 'entrada', left(coalesce(p_resumo, ''), 1500), 'neo');
  return jsonb_build_object('prospeccao', true, 'oportunidade_id', v_op);
end $$;

/** "Não quero receber mensagens": bloqueia o número em todas as filas e descarta as oportunidades abertas. */
create or replace function neo.registrar_opt_out(p_telefone text, p_motivo text default 'pediu pelo WhatsApp')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tel text := neo._normalizar(p_telefone); v_n int;
begin
  if v_tel is null then return jsonb_build_object('ok', false, 'erro', 'telefone inválido'); end if;
  insert into public.opt_out (chave, valor, motivo) values ('telefone', v_tel, left(p_motivo, 500))
  on conflict (chave, valor) do nothing;
  update public.oportunidade o set status = 'descartada'
   where o.status not in ('ganha', 'perdida', 'descartada')
     and exists (select 1 from public.contato c where c.empresa_id = o.empresa_id and c.valor_normalizado = v_tel);
  get diagnostics v_n = row_count;
  update neo.envio set status = 'cancelado', erro = 'opt-out' where telefone = v_tel and status = 'reservado';
  return jsonb_build_object('ok', true, 'oportunidades_descartadas', v_n);
end $$;

/** Quando alguém responde, o Neo pode saber se é um prospect e com que contexto. */
create or replace function neo.contexto_por_telefone(p_telefone text)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when x.oportunidade_id is null then jsonb_build_object('prospeccao', false)
              else jsonb_build_object('prospeccao', true, 'oportunidade_id', x.oportunidade_id,
                                      'primeira_mensagem', x.mensagem, 'enviado_em', x.enviado_em,
                                      'contexto', neo.montar_contexto(x.oportunidade_id)) end
  from (select null) d
  left join lateral (select e.oportunidade_id, e.mensagem, e.enviado_em from neo.envio e
                      where e.telefone = neo._normalizar(p_telefone) and e.status = 'enviado' and not e.teste
                      order by e.enviado_em desc limit 1) x on true
$$;

-- ------------------------------------------------------------------ permissões
revoke all on all functions in schema neo from public;
-- No Supabase, funções novas ganham EXECUTE para os papéis da API por padrão: retira explicitamente
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all functions in schema neo from %I', r);
      execute format('revoke all on schema neo from %I', r);
      execute format('revoke all on all tables in schema neo from %I', r);
    end if;
  end loop;
end $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'neo_n8n') then
    create role neo_n8n login noinherit;  -- senha definida pelo dono do projeto: alter role neo_n8n password '...'
  end if;
end $$;
grant usage on schema neo to neo_n8n;
grant execute on function neo.reservar(int), neo.registrar_envio(uuid, text, boolean, text),
  neo.registrar_resposta(text, text), neo.registrar_opt_out(text, text), neo.contexto_por_telefone(text) to neo_n8n;
