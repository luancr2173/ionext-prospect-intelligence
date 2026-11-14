import { EvidenciaManual } from '@ionext/contratos';
import { classificarPresenca, type Verificacoes } from '@ionext/dominio';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.ts';
import { recalcularOportunidade } from '../servicos/oportunidade.ts';

const Filtros = z.object({
  uf: z.string().length(2).optional(),
  cidade: z.string().optional(),
  bairro: z.string().optional(),
  segmento: z.string().optional(),
  classificacao: z.enum(['SEM_SITE', 'SOMENTE_REDES', 'PRESENCA_FRACA', 'SITE_EXISTENTE', 'PENDENTE']).optional(),
  prioridade: z.enum(['alta', 'media', 'baixa']).optional(),
  status: z.string().optional(),
  busca: z.string().uuid().optional(),
  q: z.string().max(100).optional(),
  canal: z.enum(['whatsapp', 'fixo', 'email', 'sem_contato']).optional(),
  limite: z.coerce.number().int().min(1).max(200).default(50),
  pagina: z.coerce.number().int().min(1).default(1),
});

/** Campos da ficha (seção 4 do projeto) que podem ficar vazios e precisam ser listados como "não encontrados". */
const CAMPOS_FICHA = ['cnpj', 'razao_social', 'segmento', 'data_abertura', 'bairro', 'endereco', 'cep'] as const;
const CONTATOS_FICHA = ['telefone', 'whatsapp', 'email', 'instagram', 'facebook', 'linkedin'] as const;

const VERIFICACOES_VAZIAS: Verificacoes = {
  V1: { status: 'nao_executado' }, V2: { status: 'nao_executado' }, V3: { status: 'nao_executado' },
  V4: { status: 'nao_executado' }, V5: { status: 'nao_executado' }, V6: { status: 'nao_executado' },
};

/**
 * Canal de contato de cada empresa (aba do painel e cartão do funil):
 * whatsapp = celular comercial (o Neo só aborda estes); fixo = só telefone fixo;
 * email = só e-mail; sem_contato = nada público. Use dentro de um select com o alias "e".
 */
export function canalLateral(sql: Sql) {
  return sql`
    left join lateral (
      select case when w.numero is not null then 'whatsapp'
                  when t.valor is not null then 'fixo'
                  when m.valor is not null then 'email'
                  else 'sem_contato' end as canal,
             coalesce(w.numero, t.valor) as telefone
        from (select 1) d
        left join lateral (select numero from neo._whatsapp(e.id)) w on true
        left join lateral (select c.valor_normalizado as valor from contato c
                            where c.empresa_id = e.id and c.tipo in ('telefone', 'whatsapp')
                            order by c.criado_em limit 1) t on true
        left join lateral (select c.valor from contato c where c.empresa_id = e.id and c.tipo = 'email' limit 1) m on true
    ) ch on true`;
}

export function rotasEmpresas(app: FastifyInstance, sql: Sql) {
  app.get('/empresas', async (req) => {
    const f = Filtros.parse(req.query);
    const offset = (f.pagina - 1) * f.limite;
    // filtros sem o canal: as contagens por canal (abas do painel) respeitam os outros filtros
    const base = sql`
      select e.id, e.nome_fantasia, e.cnpj, e.segmento, e.uf, e.cidade, e.bairro,
             p.classificacao, p.confiabilidade, p.url_site, o.id as oportunidade_id, o.tipo as oportunidade,
             o.lead_score, o.prioridade, o.status, ch.canal, ch.telefone
        from empresa e
        left join presenca_digital p on p.empresa_id = e.id
        left join lateral (
          select id, tipo, lead_score, prioridade, status from oportunidade
           where empresa_id = e.id order by lead_score desc nulls last limit 1) o on true
        ${canalLateral(sql)}
       where true
         ${f.uf ? sql`and e.uf = ${f.uf.toUpperCase()}` : sql``}
         ${f.cidade ? sql`and e.cidade ilike ${f.cidade}` : sql``}
         ${f.bairro ? sql`and e.bairro ilike ${f.bairro}` : sql``}
         ${f.segmento ? sql`and e.segmento = ${f.segmento}` : sql``}
         ${f.classificacao ? sql`and p.classificacao = ${f.classificacao}` : sql``}
         ${f.prioridade ? sql`and o.prioridade = ${f.prioridade}` : sql``}
         ${f.status ? sql`and o.status = ${f.status}` : sql``}
         ${f.busca ? sql`and exists (select 1 from busca_resultado br where br.busca_id = ${f.busca} and br.empresa_id = e.id)` : sql``}
         ${f.q ? sql`and (e.nome_normalizado like ${'%' + f.q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') + '%'} or e.cnpj = ${f.q.replace(/[^0-9A-Za-z]/g, '').toUpperCase()})` : sql``}`;
    const [linhas, contagens] = await Promise.all([
      sql`
        with base as (${base})
        select *, count(*) over()::int as total from base
         ${f.canal ? sql`where canal = ${f.canal}` : sql``}
         order by lead_score desc nulls last, nome_fantasia
         limit ${f.limite} offset ${offset}`,
      sql`with base as (${base}) select canal, count(*)::int as total from base group by canal`,
    ]);
    return {
      total: linhas[0]?.total ?? 0,
      pagina: f.pagina,
      canais: Object.fromEntries(contagens.map((c) => [c.canal as string, c.total as number])),
      itens: linhas.map(({ total: _t, ...r }) => r),
    };
  });

  app.get('/empresas/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [empresa] = await sql`select * from empresa where id = ${id}`;
    if (!empresa) return reply.code(404).send({ erro: 'empresa não encontrada' });

    const [contatos, identificadores, evidencias, presenca, auditorias, oportunidades, revisoes, whatsapp, envios] = await Promise.all([
      sql`select c.tipo, c.valor, c.publico_comercial, c.evidencia_id, ev.fonte, ev.url as fonte_url
            from contato c left join evidencia ev on ev.id = c.evidencia_id where c.empresa_id = ${id}`,
      sql`select fonte, valor from identificador_externo where empresa_id = ${id}`,
      sql`select id, fonte, url, coletado_em, expira_em, confiabilidade, operador, payload
            from evidencia where empresa_id = ${id} order by coletado_em desc`,
      sql`select * from presenca_digital where empresa_id = ${id}`,
      sql`select * from auditoria where empresa_id = ${id} order by executada_em desc`,
      sql`select o.*, coalesce((select json_agg(i order by i.registrado_em desc) from interacao i
                                where i.oportunidade_id = o.id), '[]') as interacoes,
                   coalesce((select json_agg(x order by x.em desc) from oportunidade_etapa x
                                where x.oportunidade_id = o.id and x.de is not null), '[]') as etapas,
                   floor(extract(epoch from now() - o.etapa_desde) / 86400)::int as dias_na_etapa,
                   o.proposta_valor::float as proposta_valor, o.previsao_fechamento::text as previsao_fechamento
            from oportunidade o where o.empresa_id = ${id}`,
      sql`select * from revisao_merge where status = 'pendente' and (empresa_a = ${id} or empresa_b = ${id})`,
      sql`select numero, fonte from neo._whatsapp(${id})`,
      sql`select x.tipo, x.teste, x.status, x.destino, x.mensagem, x.erro, x.reservado_em, x.enviado_em
            from neo.envio x join oportunidade o on o.id = x.oportunidade_id
           where o.empresa_id = ${id} order by x.reservado_em desc limit 20`,
    ]);

    const tiposContato = new Set(contatos.map((c) => c.tipo as string));
    const nao_encontrado = [
      ...CAMPOS_FICHA.filter((k) => empresa[k] == null),
      ...CONTATOS_FICHA.filter((t) => !tiposContato.has(t)).map((t) => `contato.${t}`),
      ...(presenca.length ? [] : ['presenca_digital']),
    ];
    const { geo: _geo, ...dados } = empresa;

    return {
      empresa: dados, contatos, identificadores, presenca_digital: presenca[0] ?? null,
      auditorias, oportunidades, revisoes_merge_pendentes: revisoes,
      neo: { whatsapp: whatsapp[0] ?? null, envios },
      validacao: {
        fontes: [...new Set(evidencias.map((e) => e.fonte as string))],
        evidencias,
        ultima_coleta: evidencias[0]?.coletado_em ?? null,
        nao_encontrado,
      },
    };
  });

  /**
   * Verificação manual feita pelo operador no navegador (perfil do Google, avaliações, link na bio...).
   * É o caminho para trazer esses dados sem API paga e sem scraping.
   */
  app.post('/empresas/:id/evidencias-manuais', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const m = EvidenciaManual.parse(req.body);

    const resultado = await sql.begin(async (tx) => {
      const [existe] = await tx`select 1 from empresa where id = ${id}`;
      if (!existe) return null;

      const [ev] = await tx<{ id: string }[]>`
        insert into evidencia (empresa_id, fonte, url, coletado_em, confiabilidade, payload, operador)
        values (${id}, 'manual', ${m.url ?? null}, now(), 'alta', ${tx.json(m as never)}, ${req.cliente})
        returning id`;

      if (m.tipo === 'perfil_google' && m.url) {
        await tx`insert into identificador_externo (empresa_id, fonte, valor)
                 values (${id}, 'google_maps_link', ${m.url}) on conflict do nothing`;
      }

      if (m.tipo === 'site_encontrado' && m.url) {
        const [p] = await tx<{ verificacoes: Verificacoes }[]>`
          select verificacoes from presenca_digital where empresa_id = ${id}`;
        const v: Verificacoes = { ...VERIFICACOES_VAZIAS, ...(p?.verificacoes ?? {}),
                                  V1: { status: 'site_encontrado', url: m.url, acessivel: true } };
        const cls = classificarPresenca(v);
        await tx`
          insert into presenca_digital (empresa_id, classificacao, url_site, verificacoes, confiabilidade,
                                        motor_versao, verificado_em, evidencia_ids)
          values (${id}, ${cls.classificacao}, ${cls.url_site}, ${tx.json({ ...v, motivos: cls.motivos } as never)},
                  ${cls.confiabilidade}, ${'manual@' + req.cliente}, now(), ${[ev!.id]}::uuid[])
          on conflict (empresa_id) do update set
            classificacao = excluded.classificacao, url_site = excluded.url_site,
            verificacoes = excluded.verificacoes, confiabilidade = excluded.confiabilidade,
            motor_versao = excluded.motor_versao, verificado_em = excluded.verificado_em,
            evidencia_ids = presenca_digital.evidencia_ids || excluded.evidencia_ids`;
      }

      const r = await recalcularOportunidade(tx, id);
      return { evidencia_id: ev!.id, classificacao: r.classificacao, lead_score: r.score?.lead_score ?? null };
    });

    if (!resultado) return reply.code(404).send({ erro: 'empresa não encontrada' });
    return reply.code(201).send(resultado);
  });
}
