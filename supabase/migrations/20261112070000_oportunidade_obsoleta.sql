-- Oportunidade "obsoleta": a classificação de presença mudou depois de criada (ex.: o reprocesso achou o site).
-- Diferente de "descartada" (decisão humana ou opt-out): volta a "nova" sozinha se a classificação voltar.
alter table public.oportunidade drop constraint if exists oportunidade_status_check;
alter table public.oportunidade add constraint oportunidade_status_check check (status in
  ('nova','revisada','aprovada_para_contato','abordada','respondeu',
   'reuniao','proposta','ganha','perdida','descartada','obsoleta'));

-- Corrige as que já estão inconsistentes
update public.oportunidade o set status = 'obsoleta'
  from public.presenca_digital p
 where p.empresa_id = o.empresa_id
   and o.status in ('nova','revisada','aprovada_para_contato')
   and ((o.tipo = 'A' and p.classificacao not in ('SEM_SITE','SOMENTE_REDES'))
     or (o.tipo = 'B' and p.classificacao <> 'PRESENCA_FRACA'));
