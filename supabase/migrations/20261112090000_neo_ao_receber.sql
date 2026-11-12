-- Quando alguém responde no WhatsApp, o Neo de atendimento chama neo.ao_receber(telefone, mensagem):
--   * diz se a conversa veio da prospecção e devolve o contexto + a primeira mensagem enviada;
--   * registra a resposta (oportunidade -> "respondeu" e interação), fora do modo teste;
--   * reconhece pedido para não receber mensagens e registra o opt-out (LGPD), fora do modo teste.
-- No modo teste, quem responde é o numero_teste: a conversa é ligada ao último envio de teste, sem mexer no funil.
create or replace function neo.ao_receber(p_telefone text, p_mensagem text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tel text := neo._normalizar(p_telefone);
  v_x neo.envio;
  v_optout boolean;
begin
  if v_tel is null then return jsonb_build_object('prospeccao', false); end if;

  select * into v_x from neo.envio e
   where e.status = 'enviado' and not e.teste and e.telefone = v_tel
   order by e.enviado_em desc limit 1;
  if v_x.id is null then
    select * into v_x from neo.envio e
     where e.status = 'enviado' and e.teste and e.destino = v_tel
       and e.enviado_em > now() - interval '7 days'
     order by e.enviado_em desc limit 1;
  end if;
  if v_x.id is null then return jsonb_build_object('prospeccao', false); end if;

  v_optout := lower(coalesce(p_mensagem, '')) ~
    '(n[aã]o (quero|tenho interesse|me (mande|envie|chame))|pare de|para de (me )?(mandar|enviar)|n[aã]o (mande|envie) mais|remov|descadastr|sair da lista|sem interesse|bloque)';

  if not v_x.teste then
    if v_optout then
      perform neo.registrar_opt_out(v_tel, 'pediu pelo WhatsApp: ' || left(p_mensagem, 200));
    else
      update public.oportunidade set status = 'respondeu' where id = v_x.oportunidade_id and status = 'abordada';
    end if;
    insert into public.interacao (oportunidade_id, canal, direcao, resumo, registrado_por)
    values (v_x.oportunidade_id, 'whatsapp', 'entrada', left(coalesce(p_mensagem, ''), 1500), 'neo');
  end if;

  return jsonb_build_object(
    'prospeccao', true,
    'teste', v_x.teste,
    'pediu_para_nao_receber', v_optout,
    'primeira_mensagem', v_x.mensagem,
    'enviado_em', v_x.enviado_em,
    'contexto', neo.montar_contexto(v_x.oportunidade_id));
end $$;

revoke all on function neo.ao_receber(text, text) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function neo.ao_receber(text, text) from %I', r);
    end if;
  end loop;
end $$;
grant execute on function neo.ao_receber(text, text) to neo_n8n;
