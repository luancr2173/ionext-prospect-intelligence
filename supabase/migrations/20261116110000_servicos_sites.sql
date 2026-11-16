-- Sites da IONEXT: landing page, site institucional e a taxa mensal de manutenção.
-- Site premium 3D e reformulação saem do catálogo (ficam inativos, dá para reativar).
update public.servico set ativo = false, atualizado_em = now() where chave in ('site_premium_3d', 'reformulacao_site');
update public.servico set categoria = 'sites', ordem = 25, nome = 'Taxa de manutenção do site',
       descricao = 'Cobrança mensal para manter o site no ar e atualizado: suporte, backups e pequenas alterações.',
       atualizado_em = now()
 where chave = 'manutencao_site';
