import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.ts';

const FUSO = 'America/Sao_Paulo';
const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instante = z.string().datetime({ offset: true });

const campos = {
  titulo: z.string().trim().min(1).max(200),
  descricao: z.string().trim().max(4000).nullable(),
  local: z.string().trim().max(300).nullable(),
  tipo: z.enum(['reuniao', 'compromisso', 'lembrete']),
  inicio: instante,
  fim: instante.nullable(),
  dia_inteiro: z.boolean(),
  empresa_id: z.string().uuid().nullable(),
  link: z.string().trim().url().max(1000).nullable(),
};

const colunas = (sql: Sql) => sql`
  c.id, c.titulo, c.descricao, c.local, c.tipo, c.inicio, c.fim, c.dia_inteiro, c.empresa_id, c.origem, c.link,
  e.nome_fantasia as empresa_nome, c.criado_em, c.atualizado_em`;

/** Calendário: demandas (pelo vencimento), reuniões do funil e compromissos (painel + Google Agenda). */
export function rotasCalendario(app: FastifyInstance, sql: Sql) {
  /** Tudo que cai entre `de` e `ate` (datas inclusivas, no fuso de Brasília). */
  app.get('/calendario', async (req, reply) => {
    const q = z.object({ de: data, ate: data }).parse(req.query);
    if (q.ate < q.de) return reply.code(400).send({ erro: 'período inválido' });
    const dias = (Date.parse(q.ate) - Date.parse(q.de)) / 86_400_000;
    if (dias > 62) return reply.code(400).send({ erro: 'período máximo de 62 dias' });
    // início do dia `de` até o fim do dia `ate`, em Brasília
    const de = sql`(${q.de}::date::timestamp at time zone ${FUSO})`;
    const ate = sql`((${q.ate}::date + 1)::timestamp at time zone ${FUSO})`;

    const [demandas, reunioes, compromissos] = await Promise.all([
      sql`
        select d.id, d.titulo, d.status, d.prioridade, d.tipo, d.projeto, to_char(d.prazo, 'YYYY-MM-DD') as prazo,
               coalesce(e.nome_fantasia, d.cliente_nome) as cliente
          from demanda d left join empresa e on e.id = d.empresa_id
         where not d.arquivada and d.prazo between ${q.de}::date and ${q.ate}::date
         order by d.prazo, case d.prioridade when 'alta' then 0 when 'media' then 1 else 2 end, d.titulo`,
      sql`
        select o.id as oportunidade_id, o.empresa_id, o.status, o.reuniao_em, e.nome_fantasia as empresa_nome
          from oportunidade o join empresa e on e.id = o.empresa_id
         where o.reuniao_em >= ${de} and o.reuniao_em < ${ate}
           and o.status not in ('perdida', 'descartada', 'obsoleta')
         order by o.reuniao_em`,
      sql`
        select ${colunas(sql)} from compromisso c left join empresa e on e.id = c.empresa_id
         where not c.cancelado and c.inicio < ${ate} and coalesce(c.fim, c.inicio) >= ${de}
         order by c.dia_inteiro desc, c.inicio`,
    ]);
    return { de: q.de, ate: q.ate, demandas, reunioes, compromissos };
  });

  app.post('/compromissos', async (req, reply) => {
    const p = z.object({
      titulo: campos.titulo,
      descricao: campos.descricao.optional(),
      local: campos.local.optional(),
      tipo: campos.tipo.default('reuniao'),
      inicio: campos.inicio,
      fim: campos.fim.optional(),
      dia_inteiro: campos.dia_inteiro.default(false),
      empresa_id: campos.empresa_id.optional(),
      link: campos.link.optional(),
    }).strict().parse(req.body);
    if (p.fim && Date.parse(p.fim) < Date.parse(p.inicio)) return reply.code(422).send({ erro: 'o fim é antes do início' });
    try {
      const [c] = await sql`
        insert into compromisso (titulo, descricao, local, tipo, inicio, fim, dia_inteiro, empresa_id, link)
        values (${p.titulo}, ${p.descricao || null}, ${p.local || null}, ${p.tipo}, ${p.inicio}, ${p.fim ?? null},
                ${p.dia_inteiro}, ${p.empresa_id ?? null}, ${p.link || null})
        returning id`;
      const [criado] = await sql`select ${colunas(sql)} from compromisso c left join empresa e on e.id = c.empresa_id where c.id = ${c!.id}`;
      return reply.code(201).send(criado);
    } catch (e) {
      if ((e as { code?: string }).code === '23503') return reply.code(422).send({ erro: 'empresa não encontrada' });
      throw e;
    }
  });

  app.patch('/compromissos/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = z.object(Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, v.optional()])) as {
      [K in keyof typeof campos]: z.ZodOptional<(typeof campos)[K]> }).strict().parse(req.body);
    const mudancas: Record<string, unknown> = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
    if (Object.keys(mudancas).length === 0) return reply.code(400).send({ erro: 'nada para atualizar' });
    for (const k of ['descricao', 'local', 'link']) if (mudancas[k] === '') mudancas[k] = null;

    const [atual] = await sql<{ origem: string; inicio: Date; fim: Date | null }[]>`
      select origem, inicio, fim from compromisso where id = ${id} and not cancelado`;
    if (!atual) return reply.code(404).send({ erro: 'compromisso não encontrado' });
    if (atual.origem === 'google') return reply.code(409).send({ erro: 'veio do Google Agenda: edite por lá' });
    const inicio = Date.parse((mudancas.inicio as string | undefined) ?? atual.inicio.toISOString());
    const fim = 'fim' in mudancas ? (mudancas.fim as string | null) : atual.fim?.toISOString() ?? null;
    if (fim && Date.parse(fim) < inicio) return reply.code(422).send({ erro: 'o fim é antes do início' });
    try {
      await sql`update compromisso set ${sql(mudancas as never)}, atualizado_em = now() where id = ${id}`;
    } catch (e) {
      if ((e as { code?: string }).code === '23503') return reply.code(422).send({ erro: 'empresa não encontrada' });
      throw e;
    }
    const [c] = await sql`select ${colunas(sql)} from compromisso c left join empresa e on e.id = c.empresa_id where c.id = ${id}`;
    return c;
  });

  /** Tira do calendário (fica como cancelado). Os do Google Agenda saem quando somem de lá. */
  app.delete('/compromissos/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [c] = await sql<{ origem: string }[]>`select origem from compromisso where id = ${id} and not cancelado`;
    if (!c) return reply.code(404).send({ erro: 'compromisso não encontrado' });
    if (c.origem === 'google') return reply.code(409).send({ erro: 'veio do Google Agenda: apague por lá' });
    await sql`update compromisso set cancelado = true, atualizado_em = now() where id = ${id}`;
    return reply.code(204).send();
  });
}
