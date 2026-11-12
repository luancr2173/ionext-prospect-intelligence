import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import type { Sql } from './db.ts';
import { rotasBuscas } from './rotas/buscas.ts';
import { rotasEmpresas } from './rotas/empresas.ts';
import { rotasIngest } from './rotas/ingest.ts';
import { rotasOptOut } from './rotas/optout.ts';

declare module 'fastify' {
  interface FastifyRequest { cliente: string }
}

function procurarChave(chaves: Map<string, string>, recebido: string): string | null {
  const a = Buffer.from(recebido);
  for (const [segredo, nome] of chaves) {
    const b = Buffer.from(segredo);
    if (a.length === b.length && timingSafeEqual(a, b)) return nome;
  }
  return null;
}

export function criarApp(sql: Sql, apiKeys: Map<string, string>, opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? true, bodyLimit: 5 * 1024 * 1024 });
  app.decorateRequest('cliente', '');

  app.get('/health', async () => {
    await sql`select 1`;
    return { ok: true };
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    const h = req.headers.authorization ?? '';
    const nome = h.startsWith('Bearer ') ? procurarChave(apiKeys, h.slice(7)) : null;
    if (!nome) return reply.code(401).send({ erro: 'não autorizado' });
    req.cliente = nome;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ erro: 'contrato inválido', detalhes: err.issues });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ erro: status >= 500 ? 'erro interno' : (err as Error).message });
  });

  app.register(async (v1) => {
    rotasIngest(v1, sql);
    rotasEmpresas(v1, sql);
    rotasOptOut(v1, sql);
    rotasBuscas(v1, sql);
  }, { prefix: '/v1' });

  return app;
}
