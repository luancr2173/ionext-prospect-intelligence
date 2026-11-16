-- Precificação organizada pelos 5 produtos do site da IONEXT ("Comece por aqui"):
-- 01 Atendimento · 02 Agendamento · 03 Acompanhamento · 04 Dashboards · 05 Sites & Landing Pages.
-- O que não é um desses produtos sai do catálogo (fica inativo; dá para reativar).

alter table public.servico drop constraint if exists servico_categoria_check;
update public.servico set categoria = 'avulso' where categoria not in ('sites', 'avulso');

update public.servico set categoria = 'atendimento', ordem = 10 where chave = 'agente_ia_implantacao';
update public.servico set categoria = 'atendimento', ordem = 11 where chave = 'agente_ia_mensal';
update public.servico set ordem = 50 where chave = 'landing_page';
update public.servico set ordem = 51 where chave = 'site_institucional';
update public.servico set ordem = 52 where chave = 'manutencao_site';
update public.servico set ativo = false, atualizado_em = now()
 where chave in ('sistema_simples', 'sistema_medio', 'automacao_fluxo', 'automacao_pacote', 'hospedagem', 'dominio', 'seo_local', 'hora_tecnica');

alter table public.servico add constraint servico_categoria_check
  check (categoria in ('atendimento', 'agendamento', 'acompanhamento', 'dashboards', 'sites', 'avulso'));

insert into public.servico (chave, nome, categoria, cobranca, unidade, descricao, preco, faixa_min, faixa_max, nota_mercado, fontes, ordem) values
('agendamento_implantacao', 'Agendamento — implantação', 'agendamento', 'unico', 'projeto',
 'Agenda conectada ao WhatsApp: cruza horários livres, confirma, sincroniza com Google Agenda/Outlook e envia lembretes.', 2000, 900, 4000,
 'Automação com 3+ integrações e regras R$ 900–2.500; fluxos complexos de várias etapas R$ 1.500–4.000.',
 '[{"titulo":"Hora de Codar — quanto custa uma automação n8n","url":"https://horadecodar.com.br/quanto-custa-automacao-n8n/"},{"titulo":"FreelaSemCrise — quanto cobrar por automação n8n","url":"https://www.freelasemcrise.com.br/quanto-cobrar/automacao-n8n-zapier"}]', 20),
('agendamento_mensal', 'Agendamento — mensalidade', 'agendamento', 'mensal', 'mes',
 'Operação dos lembretes e da sincronização da agenda, com ajustes.', 300, 39, 1469,
 'Software de agendamento pronto a partir de R$ 39/mês; plataformas de WhatsApp com automação de R$ 459 a R$ 1.469/mês.',
 '[{"titulo":"Dealism — preços de software de agendamento","url":"https://dealism.ai/pt/learn/scheduling-software-pricing-implementation"},{"titulo":"SleekFlow — quanto custa um chatbot para WhatsApp","url":"https://sleekflow.io/pt-br/blog/quanto-custa-um-chatbot-para-whatsapp"}]', 21),
('acompanhamento_implantacao', 'Acompanhamento — implantação', 'acompanhamento', 'unico', 'projeto',
 'Follow-up e reativação: retoma propostas paradas, cadencia contatos e reativa clientes inativos com mensagens personalizadas.', 2500, 1500, 4000,
 'Fluxo complexo de várias etapas com condições R$ 1.500–4.000.',
 '[{"titulo":"FreelaSemCrise — quanto cobrar por automação n8n","url":"https://www.freelasemcrise.com.br/quanto-cobrar/automacao-n8n-zapier"}]', 30),
('acompanhamento_mensal', 'Acompanhamento — mensalidade', 'acompanhamento', 'mensal', 'mes',
 'Operação das cadências e campanhas de reativação, com ajustes de mensagem.', 500, 459, 989,
 'Plataformas de WhatsApp com automação de campanhas: R$ 459/mês (SleekFlow Pro), R$ 600/mês (Zenvia Specialist), R$ 989/mês (RD Station Conversas).',
 '[{"titulo":"SleekFlow — quanto custa um chatbot para WhatsApp","url":"https://sleekflow.io/pt-br/blog/quanto-custa-um-chatbot-para-whatsapp"},{"titulo":"Hora de Codar — plataformas de campanha no WhatsApp 2026","url":"https://horadecodar.com.br/automacao-de-campanhas-no-whatsapp-10-plataformas-para-disparos-jornadas-e-recuperacao-de-vendas-no-brasil-em-2026/"}]', 31),
('dashboard', 'Dashboard do funil', 'dashboards', 'unico', 'projeto',
 'Painel com as métricas do funil em tempo real: conversão, tempo de resposta, gargalos por etapa e custo por oportunidade.', 2500, 1000, 8000,
 'Dashboard simples (1 fonte) R$ 1.000–3.000; com várias fontes R$ 3.000–8.000.',
 '[{"titulo":"FreelaSemCrise — quanto cobrar por dashboard de BI","url":"https://www.freelasemcrise.com.br/quanto-cobrar/criar-dashboard-bi"}]', 40)
on conflict (chave) do nothing;
