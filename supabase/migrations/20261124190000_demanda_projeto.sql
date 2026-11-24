-- Demandas (demanda "input", 24/11): cada demanda pode dizer para qual projeto ela é
-- (ex.: "Site IONEXT", "IONEXT Prospect Intelligence"). Texto livre; o painel sugere os já usados.
alter table public.demanda
  add column if not exists projeto text check (projeto is null or length(btrim(projeto)) between 1 and 120);
create index if not exists demanda_projeto_idx on public.demanda (projeto) where projeto is not null;
