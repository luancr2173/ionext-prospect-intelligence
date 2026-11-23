-- Neo aborda todos os tipos de oportunidade (demanda "Abordagem do Neo", 23/11).
-- Antes só a oportunidade A (primeiro site) entrava na fila. Agora B (reformulação), C (melhorias)
-- e D (automação/agente de IA) também entram, cada uma com a oferta de public.oferta_da_oportunidade.
-- * neo.reservar: sai o filtro tipo = 'A'; uma empresa recebe só uma abordagem (mesmo com A e D aprovadas)
--   e no máximo um envio por empresa em cada rodada;
-- * neo.montar_contexto: diagnóstico de quem já tem site (resumo + o que a auditoria achou: um ponto
--   positivo real e até 2 melhorias), para o Neo não dizer "não encontrei seu site" a quem tem.

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


CREATE OR REPLACE FUNCTION neo.montar_contexto(p_oportunidade_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'empresa', jsonb_build_object(
      'nome', e.nome_fantasia,
      'segmento', case e.segmento
        when 'clinica_odontologica' then 'clínica odontológica' when 'clinica_medica' then 'clínica médica'
        when 'academia' then 'academia' when 'restaurante' then 'restaurante' when 'beleza' then 'salão/barbearia'
        when 'oficina_mecanica' then 'oficina mecânica' when 'construcao_civil' then 'construtora'
        when 'imobiliaria' then 'imobiliária' when 'contabilidade' then 'escritório de contabilidade'
        when 'loja_celular' then 'loja de celular e assistência técnica' when 'loja_roupas' then 'loja de roupas'
        when 'otica' then 'ótica' when 'pet_shop' then 'pet shop' when 'loja_informatica' then 'loja de informática'
        when 'loja_moveis' then 'loja de móveis' when 'loja_cosmeticos' then 'loja de cosméticos e perfumaria'
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
        when 'SITE_EXISTENTE' then case when o.tipo in ('B', 'C')
          then 'A empresa tem site próprio, e a análise encontrou pontos que podem melhorar.'
          else 'A empresa tem site próprio, que está funcionando bem.' end
        else 'Presença digital a confirmar.' end,
      'site', p.url_site,
      'redes', coalesce((select jsonb_agg(c.valor order by c.tipo) from public.contato c
                          where c.empresa_id = e.id and c.tipo in ('instagram', 'facebook', 'linkedin')), '[]'::jsonb),
      'avaliacoes', (select jsonb_build_object('quantidade', ev.payload->'quantidade', 'nota', ev.payload->'nota')
                       from public.evidencia ev where ev.empresa_id = e.id and ev.fonte = 'manual'
                        and ev.payload->>'tipo' = 'avaliacoes' order by ev.coletado_em desc limit 1),
      -- empresa com site (B/C/D): o que a auditoria achou, para o Neo citar um ponto real (elogio + 1 melhoria)
      'auditoria', (select jsonb_build_object(
                      'ponto_positivo', (select pp->>'detalhe' from jsonb_array_elements(a.pontos_positivos) pp limit 1),
                      'melhorias', coalesce((select jsonb_agg(ac->>'titulo') from (
                                     select ac from jsonb_array_elements(a.achados) ac
                                      where ac->>'gravidade' in ('grave', 'moderado')
                                      order by (ac->>'gravidade' = 'grave') desc limit 2) x), '[]'::jsonb),
                      'sem_atendimento_automatico', exists (select 1 from jsonb_array_elements(a.achados) ac
                                                             where ac->>'codigo' = 'sem_atendimento_automatico'))
                      from public.auditoria a where a.empresa_id = e.id order by a.executada_em desc limit 1)),
    'oportunidade', jsonb_build_object(
      'tipo', o.tipo,
      'objetivo', 'apresentar ' || (public.oferta_da_oportunidade(o.id)->>'nome'),
      'lead_score', o.lead_score),
    -- Foco: UMA oferta principal; a complementar só se o cliente mostrar interesse.
    'oferta', public.oferta_da_oportunidade(o.id),
    'servicos_depois_do_diagnostico', jsonb_build_array('automação comercial', 'acompanhamento (follow-up)', 'dashboards'),
    -- O que a IONEXT faz (texto fixo, aprovado pela IONEXT) e ganhos típicos do segmento.
    -- São descrições do serviço, não números nem resultados: o Neo não pode transformá-los em promessa.
    -- portfólio: só entra no contexto quando o link estiver no ar (neo.config.portfolio_url)
    -- modelo do ramo: vai junto da primeira mensagem quando a oferta é o site
    'modelo', case when public.oferta_da_oportunidade(o.id)->>'produto' = 'site' then public.modelo_do_ramo(e.id) end,
    'portfolio', case when coalesce(neo._cfg('portfolio_url'), '') <> '' then jsonb_build_object(
      'url', neo._cfg('portfolio_url'),
      'o_que_e', 'Sites-modelo de demonstração criados pela IONEXT para vários ramos (clínicas odontológicas, restaurantes, hamburgueria, pizzaria, barbearias, salão de beleza, lojas e assistência de celular), sem marca real.',
      'quando_enviar', 'Só quando o cliente demonstrar interesse em ver outros exemplos além do modelo do ramo.',
      'como_apresentar', 'Diga que são modelos de demonstração. Nunca diga ou dê a entender que são clientes da IONEXT.') end,
    'sobre_ionext', 'A IONEXT cria sites profissionais (pensados para serem encontrados no Google) e agentes de IA que atendem os clientes da empresa pelo WhatsApp: respondem dúvidas, marcam horários e passam para a equipe o que precisa de uma pessoa.',
    'beneficios_segmento', case e.segmento
      when 'clinica_odontologica' then jsonb_build_array(
        'ser encontrada no Google por quem procura dentista na região',
        'mostrar tratamentos, equipe, convênios e localização em um só lugar',
        'botão para o paciente chamar a clínica no WhatsApp direto do site',
        'passar mais confiança para quem ainda não conhece a clínica')
      when 'clinica_medica' then jsonb_build_array(
        'ser encontrada no Google por quem procura a especialidade na região',
        'mostrar especialidades, médicos, convênios e localização',
        'botão para o paciente chamar a clínica no WhatsApp direto do site')
      when 'academia' then jsonb_build_array(
        'mostrar planos, modalidades e horários',
        'receber pedidos de aula experimental pelo site e pelo WhatsApp')
      when 'restaurante' then jsonb_build_array(
        'cardápio e horários sempre atualizados num site próprio',
        'botão para pedidos e reservas pelo WhatsApp')
      when 'beleza' then jsonb_build_array(
        'mostrar serviços e trabalhos realizados',
        'botão para agendar pelo WhatsApp direto do site')
      when 'loja_celular' then jsonb_build_array(
        'ser encontrada no Google por quem procura celular, acessórios ou conserto na região',
        'mostrar aparelhos, acessórios e serviços de assistência técnica num só lugar',
        'botão para o cliente pedir orçamento de conserto ou perguntar por um aparelho no WhatsApp')
      when 'loja_informatica' then jsonb_build_array(
        'ser encontrada no Google por quem procura informática ou conserto de computador na região',
        'mostrar produtos e serviços num só lugar',
        'botão para o cliente pedir orçamento pelo WhatsApp direto do site')
      when 'loja_roupas' then jsonb_build_array(
        'vitrine das peças e novidades num site próprio, além do Instagram',
        'botão para o cliente perguntar tamanho e disponibilidade pelo WhatsApp',
        'ser encontrada no Google por quem procura a loja na região')
      when 'otica' then jsonb_build_array(
        'ser encontrada no Google por quem procura ótica na região',
        'mostrar armações, lentes, marcas e se faz exame de vista',
        'botão para o cliente pedir orçamento da receita pelo WhatsApp')
      when 'pet_shop' then jsonb_build_array(
        'ser encontrado no Google por quem procura pet shop na região',
        'mostrar serviços (banho e tosa, por exemplo) e produtos',
        'botão para agendar ou pedir pelo WhatsApp direto do site')
      when 'loja_moveis' then jsonb_build_array(
        'mostrar os móveis e ambientes num catálogo bonito no site',
        'botão para o cliente pedir orçamento pelo WhatsApp',
        'ser encontrada no Google por quem procura móveis na região')
      when 'loja_cosmeticos' then jsonb_build_array(
        'mostrar marcas e produtos num catálogo no site',
        'botão para o cliente consultar um produto pelo WhatsApp',
        'ser encontrada no Google por quem procura a loja na região')
      else jsonb_build_array(
        'ser encontrada no Google por quem procura o serviço na região',
        'mostrar serviços e formas de contato num site próprio',
        'botão para chamar no WhatsApp direto do site') end,
    'regras', jsonb_build_array(
      'Você é o Neo, da IONEXT. Só na primeira mensagem você se apresenta, em poucas palavras; na conversa, não se reapresente.',
      'Fale da oferta principal (oferta.nome), usando oferta.ganhos (ou beneficios_segmento, se a oferta for o site). Mencione oferta.complementar só se o cliente mostrar interesse e fizer sentido, em uma frase. Não ofereça servicos_depois_do_diagnostico antes de a sessão de diagnóstico estar marcada.',
      'Use apenas os fatos deste contexto. Não invente números, clientes, resultados, preços ou promessas.',
      'Seja consultivo e respeitoso: nunca diga que a empresa está mal, errada ou ultrapassada.',
      'Escreva como no WhatsApp: mensagens curtas (até 3 frases), uma pergunta por vez, sem anexos e sem links (só o do modelo do ramo e o do portfólio, quando fizer sentido). O modelo é de demonstração, sem marca real: nunca diga que foi feito para a empresa nem que é de um cliente.',
      'A frase "Se preferir não receber mensagens, é só me avisar." vai só na primeira mensagem e no follow-up, não nas respostas da conversa.'))
  from public.oportunidade o
  join public.empresa e on e.id = o.empresa_id
  left join public.presenca_digital p on p.empresa_id = e.id
  where o.id = p_oportunidade_id
$function$;

