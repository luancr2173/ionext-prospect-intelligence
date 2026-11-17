-- Lojistas no Motor 01 (17/11): o Neo recebe o nome do segmento e ganhos do site para cada tipo de loja.

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
      'objetivo', case o.tipo when 'A' then 'criar o primeiro site profissional da empresa'
                              when 'B' then 'reformular o site da empresa'
                              when 'C' then 'melhorar o site atual (velocidade, celular e contato)'
                              else 'automação comercial e atendimento com IA' end,
      'lead_score', o.lead_score),
    -- Foco: um serviço por vez. O resto só depois da sessão de diagnóstico marcada.
    'servicos_depois_do_diagnostico', case when o.tipo in ('A', 'B', 'C')
      then jsonb_build_array('atendimento com IA no WhatsApp (responde dúvidas e agenda horários)', 'automação comercial')
      else '[]'::jsonb end,
    -- O que a IONEXT faz (texto fixo, aprovado pela IONEXT) e ganhos típicos do segmento.
    -- São descrições do serviço, não números nem resultados: o Neo não pode transformá-los em promessa.
    -- portfólio: só entra no contexto quando o link estiver no ar (neo.config.portfolio_url)
    'portfolio', case when coalesce(neo._cfg('portfolio_url'), '') <> '' then jsonb_build_object(
      'url', neo._cfg('portfolio_url'),
      'o_que_e', 'Três sites-modelo para clínicas odontológicas (estética, odontopediatria e ortodontia), sem marca real, criados pela IONEXT para mostrar o padrão de trabalho.',
      'quando_enviar', 'Só quando a clínica demonstrar interesse: pedir exemplos, perguntar como ficaria o site ou querer ver trabalhos. Nunca na primeira mensagem.',
      'como_apresentar', 'Diga que são modelos de demonstração. Nunca diga ou dê a entender que são clientes da IONEXT.') end,
    'sobre_ionext', 'A IONEXT cria sites profissionais para empresas, pensados para serem encontrados no Google e facilitarem o contato pelo WhatsApp.',
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
      'Fale só do site (objetivo). Não ofereça servicos_depois_do_diagnostico antes de a sessão de diagnóstico estar marcada.',
      'Use apenas os fatos deste contexto. Não invente números, clientes, resultados, preços ou promessas.',
      'Seja consultivo e respeitoso: nunca diga que a empresa está mal, errada ou ultrapassada.',
      'Escreva como no WhatsApp: mensagens curtas (até 3 frases), uma pergunta por vez, sem anexos e sem links (só o do portfólio, quando o cliente pedir).',
      'A frase "Se preferir não receber mensagens, é só me avisar." vai só na primeira mensagem e no follow-up, não nas respostas da conversa.'))
  from public.oportunidade o
  join public.empresa e on e.id = o.empresa_id
  left join public.presenca_digital p on p.empresa_id = e.id
  where o.id = p_oportunidade_id
$function$;
