-- CRM: valor e datas do negócio + caixa de respostas.
--   reuniao_em           data e hora da reunião marcada
--   proposta_valor       valor da proposta (R$); numa oportunidade ganha é o valor fechado
--   proposta_solucao     o que foi proposto (site, landing page, automação...)
--   previsao_fechamento  quando se espera a decisão
--   respostas_vistas_em  até quando a caixa de respostas já foi conferida (mensagens depois disso voltam a aparecer)

alter table public.oportunidade
  add column if not exists reuniao_em timestamptz,
  add column if not exists proposta_valor numeric(12, 2),
  add column if not exists proposta_solucao text,
  add column if not exists previsao_fechamento date,
  add column if not exists respostas_vistas_em timestamptz;

do $$ begin
  alter table public.oportunidade add constraint oportunidade_proposta_valor_ck check (proposta_valor is null or proposta_valor >= 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.oportunidade add constraint oportunidade_proposta_solucao_ck check (proposta_solucao is null or length(proposta_solucao) <= 300);
exception when duplicate_object then null; end $$;

-- a caixa de respostas procura a última mensagem recebida de cada oportunidade
create index if not exists interacao_entrada_idx on public.interacao (oportunidade_id, registrado_em desc) where direcao = 'entrada';
