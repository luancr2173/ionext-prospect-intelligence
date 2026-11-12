-- Contexto comercial do Neo: o que a IONEXT faz e ganhos típicos por segmento (texto fixo, sem números).
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
    -- O que a IONEXT faz (texto fixo, aprovado pela IONEXT) e ganhos típicos do segmento.
    -- São descrições do serviço, não números nem resultados: o Neo não pode transformá-los em promessa.
    'sobre_ionext', 'A IONEXT cria sites profissionais, landing pages e atendimento automático com inteligência artificial no WhatsApp, que responde dúvidas e agenda horários a qualquer hora.',
    'beneficios_segmento', case e.segmento
      when 'clinica_odontologica' then jsonb_build_array(
        'ser encontrada no Google por quem procura dentista na região',
        'mostrar tratamentos, equipe, convênios e localização em um só lugar',
        'botão para o paciente chamar no WhatsApp ou agendar direto pelo site',
        'assistente de IA que responde dúvidas e marca consultas mesmo fora do horário da recepção')
      when 'clinica_medica' then jsonb_build_array(
        'ser encontrada no Google por quem procura a especialidade na região',
        'mostrar especialidades, médicos, convênios e localização',
        'agendamento pelo WhatsApp com assistente de IA, inclusive fora do horário')
      when 'academia' then jsonb_build_array(
        'mostrar planos, modalidades e horários',
        'receber pedidos de aula experimental pelo site e pelo WhatsApp',
        'assistente de IA que responde dúvidas sobre planos a qualquer hora')
      when 'restaurante' then jsonb_build_array(
        'cardápio e horários sempre atualizados num site próprio',
        'pedidos e reservas pelo WhatsApp com atendimento automático')
      when 'beleza' then jsonb_build_array(
        'mostrar serviços e trabalhos realizados',
        'agendamento pelo WhatsApp com assistente de IA, sem depender de alguém respondendo')
      else jsonb_build_array(
        'ser encontrada no Google por quem procura o serviço na região',
        'mostrar serviços e formas de contato num site próprio',
        'atendimento automático com IA no WhatsApp') end,
    'regras', jsonb_build_array(
      'Apresente-se como Neo, assistente virtual da IONEXT, e diga o que a IONEXT faz (sobre_ionext).',
      'Use apenas os fatos deste contexto. Não invente números, clientes, resultados, preços ou promessas.',
      'Seja consultivo e respeitoso: nunca diga que a empresa está mal, errada ou ultrapassada.',
      'Mensagem curta (até 5 frases curtas), sem links e sem anexos.',
      'Termine com uma pergunta aberta e com a frase: "Se preferir não receber mensagens, é só me avisar."'))
  from public.oportunidade o
  join public.empresa e on e.id = o.empresa_id
  left join public.presenca_digital p on p.empresa_id = e.id
  where o.id = p_oportunidade_id
$$;

revoke all on function neo.montar_contexto(uuid) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function neo.montar_contexto(uuid) from %I', r);
    end if;
  end loop;
end $$;
