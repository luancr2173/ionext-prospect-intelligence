-- Conversa com a Prime Contabilidade (17/11): o número do cadastro era do escritório de contabilidade,
-- que tem resposta automática. Três problemas:
--  1) o WhatsApp mandou a 2ª mensagem com o número no formato "556196339844:42@s.whatsapp.net" (":42" = aparelho);
--     _normalizar juntava o 42 ao número, a conversa não era reconhecida e o Neo respondeu como se fosse
--     um contato novo ("como posso te chamar?");
--  2) o Neo respondeu às mensagens automáticas ("agradece seu contato", "número do seu atendimento");
--  3) o número era de terceiro (contabilidade) e o Neo seguiu falando da outra empresa.

create or replace function neo._normalizar(p_telefone text) returns text
language sql immutable set search_path = '' as $$
  select case when t ~ '^\+55\d{2}[6-9]\d{7}$' then substr(t, 1, 5) || '9' || substr(t, 6) else t end
  from (select case
          when d ~ '^55\d{10,11}$' then '+' || d
          when d ~ '^\d{10,11}$' then '+55' || d
          else null end as t
        -- "5561...:42@s.whatsapp.net": o que vem depois de ":" é o aparelho, não faz parte do número
        from (select regexp_replace(split_part(split_part(coalesce(p_telefone, ''), '@', 1), ':', 1), '\D', '', 'g') as d) x) y
$$;

/** Mensagem típica de resposta automática / URA de atendimento (não foi uma pessoa que escreveu). */
create or replace function neo._resposta_automatica(p_mensagem text) returns boolean
language sql immutable set search_path = '' as $$
  select lower(coalesce(p_mensagem, '')) ~ (
    'agradece (o )?(seu )?contato|obrigad[oa] (por|pelo) (seu |o )?contato|agradecemos (o )?(seu )?contato'
    || '|n[uú]mero do (seu )?(atendimento|protocolo)|protocolo( de atendimento)?:? *\d'
    || '|digite *:? *(\d|/|\*)|/encerrar|\*/encerrar'
    || '|mensagem autom[aá]tica|resposta autom[aá]tica|atendimento autom[aá]tico'
    || '|responderemos (o mais|em breve|assim que)|em breve (retornaremos|responderemos|um atendente)'
    || '|retornaremos (o mais|em breve|assim que)|aguarde (um momento|que um|enquanto)|em instantes (um|voc[eê])'
    || '|um de nossos (atendentes|consultores)|voc[eê] (est[aá]|entrou) na fila'
    || '|escolha uma (das )?op[cç]|selecione uma (das )?op[cç]|nosso hor[aá]rio de atendimento|fora do (nosso )?hor[aá]rio'
    || '|seja bem[- ]vind[oa] (ao|[aà]) (atendimento|canal)')
$$;

drop function if exists neo.ao_receber(text, text);
/** Quando alguém responde: diz se veio da prospecção, devolve o contexto, registra a resposta,
 *  reconhece opt-out (duvidoso vai para revisão), resposta automática (o Neo não responde) e número
 *  de terceiro, como o do contador (pausa o Neo para uma pessoa olhar), e avisa se uma pessoa assumiu. */
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

revoke all on function neo.ao_receber(text, text, text), neo._resposta_automatica(text) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function neo.ao_receber(text, text, text) from %I', r);
    end if;
  end loop;
end $$;
grant execute on function neo.ao_receber(text, text, text) to neo_n8n;
