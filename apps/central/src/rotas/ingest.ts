import { IngestCandidatas } from '@ionext/contratos';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../db.ts';
import { ingerirCandidatas } from '../servicos/ingestao.ts';

export function rotasIngest(app: FastifyInstance, sql: Sql) {
  app.post('/ingest/candidatas', async (req) => {
    const lote = IngestCandidatas.parse(req.body);
    return ingerirCandidatas(sql, lote);
  });
}
