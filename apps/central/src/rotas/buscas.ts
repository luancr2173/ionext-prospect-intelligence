import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.ts';

export const FiltrosBusca = z.object({
  pais: z.string().length(2).default('BR'),
  uf: z.string().length(2),
  cidade: z.string().min(2),
  bairros: z.array(z.string()).default([]),
  segmento: z.string().min(2),
  cnaes: z.array(z.string().regex(/^\d{7}$/)).default([]),
  portes: z.array(z.enum(['MEI', 'ME', 'EPP', 'DEMAIS'])).default([]),
  quantidade_desejada: z.number().int().min(1).max(5000).default(100),
  classificacoes: z.array(z.enum(['SEM_SITE', 'SOMENTE_REDES', 'PRESENCA_FRACA', 'SITE_EXISTENTE'])).default([]),
});

export function rotasBuscas(app: FastifyInstance, sql: Sql) {
  /** Registra a busca. A execução fica com o Motor 01 (Fase 1). */
  app.post('/buscas', async (req, reply) => {
    const filtros = FiltrosBusca.parse(req.body);
    const [b] = await sql`insert into busca (filtros, criado_por) values (${sql.json(filtros as never)}, ${req.cliente})
                          returning id, status, criado_em`;
    return reply.code(201).send(b);
  });

  app.get('/buscas/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [b] = await sql`
      select b.*, (select count(*)::int from busca_resultado r where r.busca_id = b.id) as empresas
        from busca b where id = ${id}`;
    if (!b) return reply.code(404).send({ erro: 'busca não encontrada' });
    return b;
  });
}
