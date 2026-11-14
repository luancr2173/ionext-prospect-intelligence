-- 1. O Neo passa a enviar todos os dias da semana (a janela de horário continua 9h–18h).
-- 2. Número que a Evolution disse não ter WhatsApp deixa de ser tratado como WhatsApp:
--    neo._whatsapp ignora esse número (o painel mostra o canal como telefone fixo e o Neo tenta
--    outro celular da empresa, se houver) e a oportunidade sai de "Na fila do Neo" para "A revisar".

update neo.config set valor = '1,2,3,4,5,6,7', descricao = 'Dias permitidos (1 = segunda ... 7 = domingo)'
 where chave = 'dias_semana';

create or replace function neo._whatsapp(p_empresa_id uuid) returns table (numero text, fonte text)
language sql stable security definer set search_path = '' as $$
  select x.numero, x.fonte from (
    select case when c.valor_normalizado ~ '^\+55\d{2}9\d{8}$' then c.valor_normalizado
                else substr(c.valor_normalizado, 1, 5) || '9' || substr(c.valor_normalizado, 6) end as numero,
           coalesce(ev.fonte, 'desconhecida')
             || case when c.valor_normalizado ~ '^\+55\d{2}9\d{8}$' then '' else ' (convertido do formato antigo: +9)' end as fonte,
           (c.tipo = 'whatsapp') as publicado,
           (c.valor_normalizado ~ '^\+55\d{2}9\d{8}$') as atual,
           c.criado_em
      from public.contato c left join public.evidencia ev on ev.id = c.evidencia_id
     where c.empresa_id = p_empresa_id and c.publico_comercial
       and c.tipo in ('whatsapp', 'telefone')
       and (c.valor_normalizado ~ '^\+55\d{2}9\d{8}$' or c.valor_normalizado ~ '^\+55\d{2}[6-9]\d{7}$')
  ) x
  where not exists (select 1 from neo.envio z where z.telefone = x.numero and z.erro = 'número sem WhatsApp')
  order by x.publicado desc, x.atual desc, x.criado_em
  limit 1
$$;

/** Número sem WhatsApp (conferido na Evolution): cancela o envio sem gastar cota, não tenta de novo
 *  e, se a empresa não tiver outro celular, tira a oportunidade da fila do Neo (volta para "A revisar"). */
create or replace function neo.registrar_sem_whatsapp(p_envio_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v neo.envio; v_saiu boolean := false;
begin
  update neo.envio set status = 'cancelado', erro = 'número sem WhatsApp'
   where id = p_envio_id and status = 'reservado' returning * into v;
  if v.id is null then return jsonb_build_object('ok', false); end if;
  if not v.teste then
    update public.oportunidade o set status = 'revisada', responsavel = 'neo'
     where o.id = v.oportunidade_id and o.status = 'aprovada_para_contato'
       and not exists (select 1 from neo._whatsapp(o.empresa_id));
    v_saiu := found;
    insert into public.interacao (oportunidade_id, canal, direcao, resumo, registrado_por)
    values (v.oportunidade_id, 'whatsapp', 'saida',
            'Número ' || v.telefone || ' não tem WhatsApp; não abordado.'
              || case when v_saiu then ' Saiu da fila do Neo e voltou para "A revisar".' else '' end, 'neo');
  end if;
  return jsonb_build_object('ok', true, 'saiu_da_fila', v_saiu);
end $$;

-- quem já ficou preso na fila com número sem WhatsApp
with presas as (
  update public.oportunidade o set status = 'revisada', responsavel = 'neo'
   where o.status = 'aprovada_para_contato'
     and exists (select 1 from neo.envio z where z.oportunidade_id = o.id and z.erro = 'número sem WhatsApp' and not z.teste)
     and not exists (select 1 from neo._whatsapp(o.empresa_id))
  returning o.id
)
insert into public.interacao (oportunidade_id, canal, direcao, resumo, registrado_por)
select id, 'whatsapp', 'saida', 'Sem WhatsApp no número cadastrado: saiu da fila do Neo e voltou para "A revisar".', 'neo' from presas;
