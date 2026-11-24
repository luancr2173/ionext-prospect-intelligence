import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.ts';

export const STATUS_DEMANDA = ['a_fazer', 'andamento', 'aguardando', 'concluida'] as const;
const TIPOS = ['atendimento', 'agendamento', 'acompanhamento', 'dashboards', 'sites', 'interno', 'outro'] as const;

const item = z.object({ texto: z.string().trim().min(1).max(200), feito: z.boolean().default(false) });
const campos = {
  titulo: z.string().trim().min(1).max(160),
  descricao: z.string().trim().max(4000).nullable(),
  tipo: z.enum(TIPOS),
  status: z.enum(STATUS_DEMANDA),
  prioridade: z.enum(['alta', 'media', 'baixa']),
  empresa_id: z.string().uuid().nullable(),
  cliente_nome: z.string().trim().max(160).nullable(),
  projeto: z.string().trim().max(120).nullable(),  // para qual projeto é a demanda (ex.: Site IONEXT)
  prazo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),  // obrigatório: não dá para apagar o vencimento
  valor: z.number().min(0).max(99_999_999).nullable(),
  checklist: z.array(item).max(50),
  posicao: z.number().finite(),
  arquivada: z.boolean(),
};

const colunas = (sql: Sql) => sql`
  d.id, d.titulo, d.descricao, d.tipo, d.status, d.prioridade, d.empresa_id, d.cliente_nome, d.projeto,
  to_char(d.prazo, 'YYYY-MM-DD') as prazo, d.valor::float as valor, d.checklist, d.posicao, d.arquivada,
  d.concluida_em, d.criado_em, d.atualizado_em, e.nome_fantasia as empresa_nome,
  (select count(*)::int from demanda_nota n where n.demanda_id = d.id) as notas`;

/** Demandas: trabalhos de cliente e tarefas internas, num quadro por status. */
export function rotasDemandas(app: FastifyInstance, sql: Sql) {
  /** Quadro: tudo que não está arquivado; concluídas só dos últimos 30 dias (o resto fica no histórico). */
  app.get('/demandas', async (req) => {
    const q = z.object({ empresa_id: z.string().uuid().optional() }).parse(req.query);
    return sql`
      select ${colunas(sql)} from demanda d left join empresa e on e.id = d.empresa_id
       where not d.arquivada
         ${q.empresa_id ? sql`and d.empresa_id = ${q.empresa_id}` : sql`and (d.status <> 'concluida' or d.concluida_em > now() - interval '30 days')`}
       -- prioridade (alta → baixa) e, dentro dela, o prazo mais próximo primeiro
       order by d.status, case d.prioridade when 'alta' then 0 when 'media' then 1 else 2 end,
                d.prazo nulls last, d.criado_em`;
  });

  /** Projetos já usados nas demandas (para sugerir no campo Projeto). */
  app.get('/demandas/projetos', async () => {
    const r = await sql<{ projeto: string }[]>`
      select projeto from demanda where projeto is not null group by projeto order by max(atualizado_em) desc limit 50`;
    return r.map((x) => x.projeto);
  });

  app.get('/demandas/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [d] = await sql`select ${colunas(sql)} from demanda d left join empresa e on e.id = d.empresa_id where d.id = ${id}`;
    if (!d) return reply.code(404).send({ erro: 'demanda não encontrada' });
    const notas = await sql`select id, texto, autor, criado_em from demanda_nota where demanda_id = ${id} order by criado_em desc`;
    return { ...d, lista_notas: notas };
  });

  app.post('/demandas', async (req, reply) => {
    const p = z.object({
      titulo: campos.titulo,
      descricao: campos.descricao.optional(),
      tipo: campos.tipo.default('outro'),
      status: campos.status.default('a_fazer'),
      prioridade: campos.prioridade.default('media'),
      empresa_id: campos.empresa_id.optional(),
      cliente_nome: campos.cliente_nome.optional(),
      projeto: campos.projeto.optional(),
      prazo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'informe a data de vencimento'),
      valor: campos.valor.optional(),
      checklist: campos.checklist.default([]),
    }).strict().parse(req.body);
    if (p.empresa_id) {
      const [e] = await sql`select 1 from empresa where id = ${p.empresa_id}`;
      if (!e) return reply.code(422).send({ erro: 'empresa não encontrada' });
    }
    // entra no topo da coluna
    const [topo] = await sql<{ min: number | null }[]>`select min(posicao) as min from demanda where status = ${p.status} and not arquivada`;
    const min = topo?.min ?? null;
    const [d] = await sql`
      insert into demanda (titulo, descricao, tipo, status, prioridade, empresa_id, cliente_nome, projeto, prazo, valor, checklist, posicao, concluida_em)
      values (${p.titulo}, ${p.descricao || null}, ${p.tipo}, ${p.status}, ${p.prioridade}, ${p.empresa_id ?? null},
              ${p.empresa_id ? null : (p.cliente_nome || null)}, ${p.projeto || null}, ${p.prazo}, ${p.valor ?? null}, ${sql.json(p.checklist)},
              ${(min ?? 1) - 1}, ${p.status === 'concluida' ? sql`now()` : null})
      returning id`;
    const [criada] = await sql`select ${colunas(sql)} from demanda d left join empresa e on e.id = d.empresa_id where d.id = ${d!.id}`;
    return reply.code(201).send(criada);
  });

  app.patch('/demandas/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = z.object(Object.fromEntries(Object.entries(campos).map(([k, v]) => [k, v.optional()])) as {
      [K in keyof typeof campos]: z.ZodOptional<(typeof campos)[K]> }).strict().parse(req.body);
    const mudancas: Record<string, unknown> = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
    if (Object.keys(mudancas).length === 0) return reply.code(400).send({ erro: 'nada para atualizar' });
    if (mudancas.descricao === '') mudancas.descricao = null;
    if (mudancas.projeto === '') mudancas.projeto = null;
    if (mudancas.empresa_id) mudancas.cliente_nome = null;
    if (mudancas.checklist) mudancas.checklist = sql.json(mudancas.checklist as never);

    const [atual] = await sql`select status from demanda where id = ${id}`;
    if (!atual) return reply.code(404).send({ erro: 'demanda não encontrada' });
    const concluiu = mudancas.status === 'concluida' && atual.status !== 'concluida';
    const reabriu = mudancas.status && mudancas.status !== 'concluida' && atual.status === 'concluida';
    // mudou de coluna sem dizer a posição: vai para o topo da nova coluna
    if (mudancas.status && mudancas.status !== atual.status && mudancas.posicao === undefined) {
      const [topo] = await sql<{ min: number | null }[]>`select min(posicao) as min from demanda where status = ${mudancas.status as string} and not arquivada`;
      const min = topo?.min ?? null;
      mudancas.posicao = (min ?? 1) - 1;
    }
    try {
      await sql`update demanda set ${sql(mudancas as never)}, atualizado_em = now()
                  ${concluiu ? sql`, concluida_em = now()` : reabriu ? sql`, concluida_em = null` : sql``}
                where id = ${id}`;
    } catch (e) {
      if ((e as { code?: string }).code === '23503') return reply.code(422).send({ erro: 'empresa não encontrada' });
      throw e;
    }
    const [d] = await sql`select ${colunas(sql)} from demanda d left join empresa e on e.id = d.empresa_id where d.id = ${id}`;
    return d;
  });

  /** Apagar de vez (o arquivamento é pelo PATCH arquivada=true). */
  app.delete('/demandas/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await sql`delete from demanda where id = ${id}`;
    if (r.count === 0) return reply.code(404).send({ erro: 'demanda não encontrada' });
    return reply.code(204).send();
  });

  app.post('/demandas/:id/notas', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { texto } = z.object({ texto: z.string().trim().min(1).max(2000) }).strict().parse(req.body);
    const [d] = await sql`select 1 from demanda where id = ${id}`;
    if (!d) return reply.code(404).send({ erro: 'demanda não encontrada' });
    const [n] = await sql`insert into demanda_nota (demanda_id, texto, autor) values (${id}, ${texto}, ${req.cliente ?? 'painel'})
                          returning id, texto, autor, criado_em`;
    await sql`update demanda set atualizado_em = now() where id = ${id}`;
    return reply.code(201).send(n);
  });
}
