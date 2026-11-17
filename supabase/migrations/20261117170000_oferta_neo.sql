-- O Neo passa a oferecer também o agente de IA no WhatsApp (17/11).
-- Cada oportunidade ganha uma OFERTA PRINCIPAL e uma COMPLEMENTAR, escolhidas pelo tipo de negócio e pela situação:
--   * negócios de agenda (clínicas, beleza, pet shop, ótica, academia, oficina) → agente que atende e AGENDA;
--   * varejo e restaurante → agente de ATENDIMENTO (preço, disponibilidade, pedido, orçamento);
--   * imobiliária, construtora, contabilidade → agente de ATENDIMENTO que qualifica o interessado.
--   Sem site e sem redes → o site vem primeiro (falta presença). Varejo que já atende pelas redes → o agente vem
--   primeiro (82% dos pequenos negócios vendem pelo WhatsApp, Sebrae 2026). Site com problema → reformular o site.
--   Site em dia → o agente.
-- Só descrições do serviço: nada de números, prazos ou resultados prometidos.

create or replace function public.oferta_da_oportunidade(p_oportunidade_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with base as (
    select o.tipo, coalesce(e.segmento, '') as seg, p.classificacao as cls
      from public.oportunidade o join public.empresa e on e.id = o.empresa_id
      left join public.presenca_digital p on p.empresa_id = e.id
     where o.id = p_oportunidade_id
  ), g as (
    select *, case
      when seg in ('clinica_odontologica', 'clinica_medica', 'beleza', 'pet_shop', 'otica', 'academia', 'oficina_mecanica') then 'agenda'
      when seg in ('imobiliaria', 'construcao_civil', 'contabilidade') then 'consultivo'
      else 'varejo' end as grupo
      from base
  ), escolha as (
    select *,
      case when tipo in ('B', 'C') or cls = 'PRESENCA_FRACA' then 'site'
           when tipo = 'D' or cls = 'SITE_EXISTENTE' then 'agente'
           when grupo = 'varejo' and cls = 'SOMENTE_REDES' then 'agente'
           else 'site' end as principal
      from g
  ), agente as (
    select *, case when grupo = 'agenda' then 'agendamento' else 'atendimento' end as agente_produto from escolha
  )
  select jsonb_build_object(
    'produto', case when principal = 'site' then 'site' else agente_produto end,
    'nome', case when principal = 'site' then case when tipo in ('B', 'C') or cls = 'PRESENCA_FRACA' then 'reformulação do site' else 'site profissional' end
                 when agente_produto = 'agendamento' then 'agente de IA no WhatsApp que atende e agenda'
                 else 'agente de IA no WhatsApp que atende os clientes' end,
    'porque', case
      when principal = 'site' and (tipo in ('B', 'C') or cls = 'PRESENCA_FRACA') then 'A empresa já tem site, mas ele tem problemas: melhorar o site é o primeiro passo.'
      when principal = 'site' then 'Não encontramos site próprio: ser encontrada no Google é o primeiro passo.'
      when cls = 'SOMENTE_REDES' then 'A empresa já vende pelas redes e pelo WhatsApp: responder rápido e a qualquer hora pesa mais que um site agora.'
      else 'A empresa já tem site: o próximo passo é atender e converter quem chama no WhatsApp.' end,
    'ganhos', case
      when principal = 'site' then null  -- usa beneficios_segmento
      when seg in ('clinica_odontologica', 'clinica_medica') then jsonb_build_array(
        'responde o paciente na hora, inclusive à noite e no fim de semana',
        'marca a consulta direto na agenda e manda lembrete antes, para reduzir faltas',
        'passa para a recepção só o que precisa de uma pessoa')
      when seg in ('beleza', 'pet_shop') then jsonb_build_array(
        'responde na hora, inclusive fora do horário',
        'marca o horário direto na agenda e lembra o cliente na véspera',
        'deixa a equipe livre para atender quem está no balcão')
      when seg in ('otica', 'academia', 'oficina_mecanica') then jsonb_build_array(
        'responde na hora as dúvidas mais comuns (preço, horário, serviços)',
        'marca o horário (exame, aula experimental ou avaliação) direto na agenda',
        'avisa a equipe quando o cliente está pronto para fechar')
      when seg = 'restaurante' then jsonb_build_array(
        'responde na hora cardápio, horário e entrega',
        'anota pedidos e reservas pelo WhatsApp',
        'deixa a equipe livre na hora do movimento')
      when grupo = 'consultivo' then jsonb_build_array(
        'responde o interessado na hora, a qualquer hora',
        'faz as perguntas certas e separa quem está pronto para conversar',
        'passa para a equipe só os contatos quentes, com o resumo da conversa')
      else jsonb_build_array(
        'responde na hora preço, disponibilidade e horário, até fora do expediente',
        'tira as dúvidas mais comuns com as informações da loja',
        'avisa o vendedor quando o cliente está pronto para comprar') end,
    'complementar', case when principal = 'site'
      then jsonb_build_object('produto', agente_produto,
             'nome', case when agente_produto = 'agendamento' then 'agente de IA no WhatsApp que atende e agenda' else 'agente de IA no WhatsApp que atende os clientes' end)
      else jsonb_build_object('produto', 'site', 'nome', case when cls in ('SEM_SITE', 'SOMENTE_REDES') then 'site profissional' else 'melhorias no site' end) end)
  from agente
$$;
revoke all on function public.oferta_da_oportunidade(uuid) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public.oferta_da_oportunidade(uuid) from %I', r);
    end if;
  end loop;
end $$;

create or replace function neo.montar_contexto(p_oportunidade_id uuid)
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
        else 'Presença digital a confirmar.' end,
      'site', p.url_site,
      'redes', coalesce((select jsonb_agg(c.valor order by c.tipo) from public.contato c
                          where c.empresa_id = e.id and c.tipo in ('instagram', 'facebook', 'linkedin')), '[]'::jsonb),
      'avaliacoes', (select jsonb_build_object('quantidade', ev.payload->'quantidade', 'nota', ev.payload->'nota')
                       from public.evidencia ev where ev.empresa_id = e.id and ev.fonte = 'manual'
                        and ev.payload->>'tipo' = 'avaliacoes' order by ev.coletado_em desc limit 1)),
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
    'portfolio', case when coalesce(neo._cfg('portfolio_url'), '') <> '' then jsonb_build_object(
      'url', neo._cfg('portfolio_url'),
      'o_que_e', 'Três sites-modelo para clínicas odontológicas (estética, odontopediatria e ortodontia), sem marca real, criados pela IONEXT para mostrar o padrão de trabalho.',
      'quando_enviar', 'Só quando a clínica demonstrar interesse: pedir exemplos, perguntar como ficaria o site ou querer ver trabalhos. Nunca na primeira mensagem.',
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
      'Escreva como no WhatsApp: mensagens curtas (até 3 frases), uma pergunta por vez, sem anexos e sem links (só o do portfólio, quando o cliente pedir).',
      'A frase "Se preferir não receber mensagens, é só me avisar." vai só na primeira mensagem e no follow-up, não nas respostas da conversa.'))
  from public.oportunidade o
  join public.empresa e on e.id = o.empresa_id
  left join public.presenca_digital p on p.empresa_id = e.id
  where o.id = p_oportunidade_id
$function$;
