-- Telefone do cadastro da Receita muitas vezes é do contador (caso Epe Enigma → Prime Contabilidade, 17/11).
-- 1) números já identificados como de outra empresa ficam numa lista (o Neo aprende com cada caso);
-- 2) um número é "suspeito" se está nessa lista, se aparece no cadastro de outra empresa (outro CNPJ)
--    ou se veio só da Receita numa empresa cujo e-mail do cadastro é de contabilidade;
-- 3) o Neo não usa número suspeito, e prefere número publicado pela empresa ao do cadastro.

create table if not exists public.telefone_terceiro (
  numero        text primary key,             -- formato +55DD9XXXXXXXX
  motivo        text not null,
  empresa_id    uuid references public.empresa(id) on delete set null,
  registrado_em timestamptz not null default now()
);
alter table public.telefone_terceiro enable row level security;

/** +55DD8XXXXXXX (formato antigo de celular) → +55DD98XXXXXXX, para comparar números. */
create or replace function public._tel9(p text) returns text
language sql immutable set search_path = '' as $$
  select case when p ~ '^\+55\d{2}[6-9]\d{7}$' then substr(p, 1, 5) || '9' || substr(p, 6) else p end
$$;

/** Motivo para desconfiar que o número não é da empresa (null = sem motivo). */
create or replace function public.telefone_suspeito(p_empresa uuid, p_numero text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_n text := public._tel9(p_numero);
  v_raiz text;
  v_outras int;
  v_motivo text;
begin
  if v_n is null then return null; end if;
  select t.motivo into v_motivo from public.telefone_terceiro t where t.numero = v_n;
  if found then return 'já identificado como de outra empresa: ' || v_motivo; end if;

  select left(e.cnpj, 8) into v_raiz from public.empresa e where e.id = p_empresa;
  select count(distinct coalesce(left(e.cnpj, 8), e.id::text)) into v_outras
    from public.contato c join public.empresa e on e.id = c.empresa_id
   where c.tipo in ('telefone', 'whatsapp') and c.empresa_id <> p_empresa
     and public._tel9(c.valor_normalizado) = v_n
     and (v_raiz is null or e.cnpj is null or left(e.cnpj, 8) <> v_raiz);
  if v_outras > 0 then
    return 'o mesmo número está no cadastro de mais ' || v_outras ||
           case when v_outras = 1 then ' empresa' else ' empresas' end || ' (provavelmente o contador)';
  end if;

  -- só veio da Receita, e o e-mail do cadastro é de escritório de contabilidade
  if exists (select 1 from public.contato c join public.evidencia ev on ev.id = c.evidencia_id
              where c.empresa_id = p_empresa and public._tel9(c.valor_normalizado) = v_n and ev.fonte = 'receita')
     and not exists (select 1 from public.contato c join public.evidencia ev on ev.id = c.evidencia_id
              where c.empresa_id = p_empresa and public._tel9(c.valor_normalizado) = v_n and ev.fonte <> 'receita')
     and exists (select 1 from public.contato c where c.empresa_id = p_empresa and c.tipo = 'email'
              and c.valor ~* '(cont[aá]b|contador|contabeis|cont[aá]beis|escritorio|escritório)') then
    return 'o e-mail do cadastro é de contabilidade, então o telefone provavelmente também é';
  end if;
  return null;
end $$;

/** Melhor número de WhatsApp da empresa: publicado > de outra fonte > do cadastro da Receita; nunca suspeito. */
create or replace function neo._whatsapp(p_empresa_id uuid) returns table (numero text, fonte text)
language sql stable security definer set search_path = '' as $$
  select x.numero, x.fonte from (
    select case when c.valor_normalizado ~ '^\+55\d{2}9\d{8}$' then c.valor_normalizado
                else substr(c.valor_normalizado, 1, 5) || '9' || substr(c.valor_normalizado, 6) end as numero,
           coalesce(ev.fonte, 'desconhecida')
             || case when c.valor_normalizado ~ '^\+55\d{2}9\d{8}$' then '' else ' (convertido do formato antigo: +9)' end as fonte,
           (c.tipo = 'whatsapp') as publicado,
           (coalesce(ev.fonte, '') <> 'receita') as fora_do_cadastro,
           (c.valor_normalizado ~ '^\+55\d{2}9\d{8}$') as atual,
           c.criado_em,
           c.valor_normalizado
      from public.contato c left join public.evidencia ev on ev.id = c.evidencia_id
     where c.empresa_id = p_empresa_id and c.publico_comercial
       and c.tipo in ('whatsapp', 'telefone')
       and (c.valor_normalizado ~ '^\+55\d{2}9\d{8}$' or c.valor_normalizado ~ '^\+55\d{2}[6-9]\d{7}$')
  ) x
  where not exists (select 1 from neo.envio z where z.telefone = x.numero and z.erro = 'número sem WhatsApp')
    and public.telefone_suspeito(p_empresa_id, x.valor_normalizado) is null
  order by x.publicado desc, x.fora_do_cadastro desc, x.atual desc, x.criado_em
  limit 1
$$;

revoke all on function public.telefone_suspeito(uuid, text) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public.telefone_suspeito(uuid, text) from %I', r);
    end if;
  end loop;
end $$;

-- o número da Epe Enigma (Prime Contabilidade) já entra na lista
insert into public.telefone_terceiro (numero, motivo, empresa_id)
select '+5561996339844', 'Prime Contabilidade (resposta automática no WhatsApp em 17/11/2026)', e.id
  from public.empresa e where e.nome_fantasia = 'Epe Enigma Producoes e Eventos'
on conflict (numero) do nothing;

/** ao_receber: quando o número é de terceiro, ele entra em telefone_terceiro. */
create or replace function neo.ao_receber(p_telefone text, p_mensagem text, p_nome text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tel text := neo._normalizar(p_telefone);
  v_x neo.envio;
  v_optout boolean;
  v_duvida boolean;
  v_auto boolean := neo._resposta_automatica(p_mensagem);
  v_terceiro boolean := false;
  v_pausado boolean := false;
  v_msg text := lower(coalesce(p_mensagem, ''));
  v_segmento text;
begin
  if v_tel is null then return jsonb_build_object('prospeccao', false); end if;
  v_x := neo._envio_da_conversa(v_tel);
  if v_x.id is null then
    -- fora da prospecção: só não responde a robô
    return jsonb_build_object('prospeccao', false, 'nao_responder', v_auto,
                              'motivo', case when v_auto then 'resposta_automatica' end);
  end if;

  v_optout := not v_auto and v_msg ~
    '(n[aã]o (quero|tenho interesse|me (mande|envie|chame))|pare de|para de (me )?(mandar|enviar)|n[aã]o (mande|envie) mais|remov|descadastr|sair da lista|sem interesse|bloque)';
  v_duvida := v_optout and v_msg ~
    '(agora|no momento|por enquanto|neste momento|nesse momento|mais (pra|para) frente|futuramente|depois|outra hora|ano que vem|pr[oó]ximo (m[eê]s|ano)|ainda n[aã]o)';

  -- número de contador/escritório (comum no cadastro da Receita): quem respondeu se apresenta como contabilidade
  select lower(coalesce(e.segmento, '') || ' ' || coalesce(e.nome_fantasia, '') || ' ' || coalesce(e.razao_social, ''))
    into v_segmento
    from public.oportunidade o join public.empresa e on e.id = o.empresa_id where o.id = v_x.oportunidade_id;
  v_terceiro := not v_optout
    and (lower(coalesce(p_nome, '')) ~ 'cont[aá]b|contador|escrit[oó]rio' or v_msg ~ 'contabilidade|contador|escrit[oó]rio de cont')
    and coalesce(v_segmento, '') !~ 'cont[aá]b|contador';

  if not v_x.teste then
    if v_optout then
      perform neo.registrar_opt_out(v_tel, 'pediu pelo WhatsApp: ' || left(p_mensagem, 200));
      update public.opt_out set revisao = case when v_duvida then 'pendente' else 'confirmado' end,
                                mensagem = left(p_mensagem, 1000), oportunidade_id = v_x.oportunidade_id
       where chave = 'telefone' and valor = v_tel and revisao is null;
    elsif not v_auto then
      update public.oportunidade set status = 'respondeu' where id = v_x.oportunidade_id and status = 'abordada';
    end if;
    insert into public.interacao (oportunidade_id, canal, direcao, resumo, registrado_por)
    values (v_x.oportunidade_id, 'whatsapp', 'entrada',
            case when v_auto then '[Resposta automática — o Neo não respondeu] ' else '' end || left(coalesce(p_mensagem, ''), 1500),
            'neo');
    if v_terceiro then
      update public.oportunidade set neo_pausado_em = coalesce(neo_pausado_em, now()), neo_pausado_por = 'neo'
       where id = v_x.oportunidade_id;
      -- o número entra na lista: outras empresas com ele no cadastro não serão abordadas
      insert into public.telefone_terceiro (numero, motivo, empresa_id)
      select v_tel, coalesce(nullif(p_nome, ''), 'quem respondeu é de outra empresa') || ' (respondeu em ' || to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY') || ')', o.empresa_id
        from public.oportunidade o where o.id = v_x.oportunidade_id
      on conflict (numero) do nothing;
      insert into public.interacao (oportunidade_id, canal, direcao, resumo, registrado_por, resultado)
      values (v_x.oportunidade_id, 'outro', 'saida',
              'Neo pausado: o número parece ser de outra empresa (' || coalesce(nullif(p_nome, ''), 'contabilidade') ||
              '), provavelmente o contador do cadastro. Confira antes de continuar.', 'neo', 'controle_neo');
    end if;
  end if;
  select o.neo_pausado_em is not null into v_pausado from public.oportunidade o where o.id = v_x.oportunidade_id;

  return jsonb_build_object(
    'prospeccao', true,
    'teste', v_x.teste,
    'pausado', coalesce(v_pausado, false) or v_terceiro,
    'nao_responder', v_auto or v_terceiro or coalesce(v_pausado, false),
    'motivo', case when v_terceiro then 'numero_de_terceiro' when v_auto then 'resposta_automatica'
                   when v_pausado then 'pausado' end,
    'pediu_para_nao_receber', v_optout,
    'primeira_mensagem', v_x.mensagem,
    'enviado_em', v_x.enviado_em,
    'contexto', neo.montar_contexto(v_x.oportunidade_id));
end $$;
