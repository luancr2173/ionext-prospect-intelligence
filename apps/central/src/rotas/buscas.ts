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

const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
/** Identidade de uma busca para detectar repetição (quantidade não entra). */
export function chaveBusca(f: Partial<z.infer<typeof FiltrosBusca>>): string {
  const lista = (x?: string[]) => [...(x ?? [])].map(norm).sort().join('|');
  return [norm(f.uf ?? ''), norm(f.cidade ?? ''), f.segmento, lista(f.bairros), lista(f.cnaes), lista(f.portes), lista(f.classificacoes)].join('#');
}

export function rotasBuscas(app: FastifyInstance, sql: Sql) {
  /** Registra a busca. A execução fica com o Motor 01 (Fase 1). */
  app.post('/buscas', async (req, reply) => {
    const filtros = FiltrosBusca.parse(req.body);
    // Mesma busca já na fila ou rodando: as duas pegariam as mesmas empresas. Repetir depois que terminar é válido
    // (o motor pula quem já foi verificado e traz as próximas empresas).
    const chave = chaveBusca(filtros);
    const ativas = await sql<{ id: string; filtros: z.infer<typeof FiltrosBusca> }[]>`
      select id, filtros from busca where status in ('planejada', 'executando', 'reprocessar')`;
    const igual = ativas.find((b) => chaveBusca(b.filtros) === chave);
    if (igual) return reply.code(409).send({ erro: 'Essa mesma busca já está em andamento. Espere terminar ou cancele a atual.', busca_id: igual.id });
    const [b] = await sql`insert into busca (filtros, criado_por) values (${sql.json(filtros as never)}, ${req.cliente})
                          returning id, status, criado_em`;
    return reply.code(201).send(b);
  });

  /** O Motor 01 informa o andamento da busca. */
  app.patch('/buscas/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = z.object({
      status: z.enum(['planejada', 'executando', 'concluida', 'falhou', 'cancelada']).optional(),
      total_celulas: z.number().int().min(0).optional(),
      concluidas: z.number().int().min(0).optional(),
    }).parse(req.body);
    const [b] = await sql`
      update busca set
        -- busca cancelada pelo painel não volta a andar por atualização do motor (só "Reprocessar" a retoma)
        status = case when status = 'cancelada' then status else coalesce(${p.status ?? null}, status) end,
        total_celulas = coalesce(${p.total_celulas ?? null}::int, total_celulas),
        concluidas = coalesce(${p.concluidas ?? null}::int, concluidas),
        concluida_em = case when status <> 'cancelada' and ${p.status ?? null} = 'concluida' then now() else concluida_em end
      where id = ${id} returning id, status, total_celulas, concluidas`;
    if (!b) return reply.code(404).send({ erro: 'busca não encontrada' });
    return b;
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
