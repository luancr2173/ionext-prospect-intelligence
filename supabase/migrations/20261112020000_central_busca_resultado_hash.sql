-- Idempotência por conteúdo: reenvio idêntico é ignorado; reenvio com informação nova (ex.: resultado da
-- busca web feita depois pelo Claude) é processado e mesclado.
alter table public.busca_resultado add column hash text;
