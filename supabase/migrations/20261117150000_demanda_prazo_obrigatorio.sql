-- Vencimento passa a ser obrigatório nas demandas (nenhuma demanda em produção estava sem prazo).
alter table public.demanda alter column prazo set not null;
