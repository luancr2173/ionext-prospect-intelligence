-- O WhatsApp identifica muitos celulares antigos sem o nono dígito (ex.: 556196213055@s.whatsapp.net),
-- e a Receita também guarda celulares no formato antigo. Comparação sempre no formato canônico (com o 9).
create or replace function neo._normalizar(p_telefone text) returns text
language sql immutable set search_path = '' as $$
  select case when t ~ '^\+55\d{2}[6-9]\d{7}$' then substr(t, 1, 5) || '9' || substr(t, 6) else t end
  from (select case
          when d ~ '^55\d{10,11}$' then '+' || d
          when d ~ '^\d{10,11}$' then '+55' || d
          else null end as t
        from (select regexp_replace(split_part(coalesce(p_telefone, ''), '@', 1), '\D', '', 'g') as d) x) y
$$;

create or replace function neo._bloqueada(p_empresa_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.opt_out o
     where (o.chave = 'cnpj' and o.valor = (select cnpj from public.empresa where id = p_empresa_id))
        or (o.chave = 'telefone' and exists (select 1 from public.contato c where c.empresa_id = p_empresa_id
                                              and c.tipo <> 'email' and neo._normalizar(c.valor_normalizado) = neo._normalizar(o.valor)))
        or (o.chave = 'email' and exists (select 1 from public.contato c where c.empresa_id = p_empresa_id
                                           and c.tipo = 'email' and c.valor_normalizado = o.valor))
        or (o.chave = 'dominio' and exists (select 1 from public.contato c where c.empresa_id = p_empresa_id
                                             and c.tipo = 'email' and split_part(c.valor_normalizado, '@', 2) = o.valor)))
$$;

create or replace function neo.registrar_opt_out(p_telefone text, p_motivo text default 'pediu pelo WhatsApp')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_tel text := neo._normalizar(p_telefone); v_n int;
begin
  if v_tel is null then return jsonb_build_object('ok', false, 'erro', 'telefone inválido'); end if;
  insert into public.opt_out (chave, valor, motivo) values ('telefone', v_tel, left(p_motivo, 500))
  on conflict (chave, valor) do nothing;
  update public.oportunidade o set status = 'descartada'
   where o.status not in ('ganha', 'perdida', 'descartada')
     and exists (select 1 from public.contato c where c.empresa_id = o.empresa_id and c.tipo <> 'email'
                   and neo._normalizar(c.valor_normalizado) = v_tel);
  get diagnostics v_n = row_count;
  update neo.envio set status = 'cancelado', erro = 'opt-out' where telefone = v_tel and status = 'reservado';
  return jsonb_build_object('ok', true, 'oportunidades_descartadas', v_n);
end $$;

revoke all on function neo._normalizar(text), neo._bloqueada(uuid), neo.registrar_opt_out(text, text) from public;
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function neo._normalizar(text), neo._bloqueada(uuid), neo.registrar_opt_out(text, text) from %I', r);
    end if;
  end loop;
end $$;
grant execute on function neo.registrar_opt_out(text, text) to neo_n8n;
