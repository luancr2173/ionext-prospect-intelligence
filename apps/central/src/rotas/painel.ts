import { SEGMENTOS } from '@ionext/dominio';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.ts';
import { canalLateral } from './empresas.ts';

/** Rotas usadas pelo painel (e úteis para integrações): resumo, segmentos, buscas, status das oportunidades e dos motores. */
export function rotasPainel(app: FastifyInstance, sql: Sql) {
  app.get('/segmentos', async () => SEGMENTOS.map((s) => ({ id: s.id, nome: s.nome, cnaes: s.cnaes })));

  app.get('/painel/resumo', async () => {
    const [totais] = await sql`
      select (select count(*)::int from empresa) as empresas,
             (select count(*)::int from oportunidade where status not in ('descartada','perdida')) as oportunidades,
             (select count(*)::int from oportunidade where prioridade = 'alta' and status not in ('descartada','perdida')) as alta_prioridade,
             (select count(*)::int from oportunidade where status in ('nova','revisada')) as aguardando_revisao,
             (select count(*)::int from oportunidade where status = 'aprovada_para_contato') as aprovadas,
             (select count(*)::int from revisao_merge where status = 'pendente') as merges_pendentes`;
    const classificacoes = await sql`
      select classificacao, count(*)::int as total from presenca_digital group by 1 order by 2 desc`;
    const prioridades = await sql`
      select prioridade, count(*)::int as total from oportunidade
       where status not in ('descartada','perdida') group by 1`;
    const motores = await sql`select nome, dados, atualizado_em,
                                     extract(epoch from now() - atualizado_em)::int as segundos_atras
                                from motor_status order by nome`;
    return { totais, classificacoes, prioridades, motores };
  });

  app.get('/buscas', async (req) => {
    const q = z.object({ status: z.string().optional(), limite: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
    const status = q.status ? q.status.split(',').map((x) => x.trim()) : null;
    return sql`
      select b.id, b.filtros, b.status, b.total_celulas, b.concluidas, b.criado_por, b.criado_em, b.concluida_em,
             (select count(*)::int from busca_resultado r where r.busca_id = b.id) as empresas
        from busca b
       ${status ? sql`where b.status = any(${status}::text[])` : sql``}
       order by b.criado_em desc limit ${q.limite}`;
  });

  /** Pede ao Motor 01 para verificar de novo as empresas da busca (com as regras atuais). */
  app.post('/buscas/:id/reprocessar', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [b] = await sql`update busca set status = 'reprocessar' where id = ${id} and status <> 'reprocessar'
                          returning id, status`;
    if (!b) return reply.code(409).send({ erro: 'busca não encontrada ou já aguardando reprocessamento' });
    return b;
  });

  /**
   * Funil comercial (visão de CRM): oportunidades por etapa, com canal de contato,
   * último envio do Neo e última interação. "nova" e "revisada" formam a etapa "A revisar".
   */
  app.get('/pipeline', async (req) => {
    const q = z.object({
      canal: z.enum(['whatsapp', 'fixo', 'email', 'sem_contato']).optional(),
      por_etapa: z.coerce.number().int().min(1).max(200).default(40),
    }).parse(req.query);
    const linhas = await sql`
      with ops as (
        select o.id, o.status, o.tipo, o.lead_score, o.prioridade, o.atualizado_em,
               case when o.status in ('nova', 'revisada') then 'revisar' else o.status end as etapa,
               e.id as empresa_id, e.nome_fantasia, e.bairro, e.segmento, ch.canal, ch.telefone,
               (select max(i.registrado_em) from interacao i where i.oportunidade_id = o.id) as ultima_interacao,
               (select json_build_object('tipo', x.tipo, 'status', x.status, 'quando', coalesce(x.enviado_em, x.reservado_em))
                  from neo.envio x where x.oportunidade_id = o.id and not x.teste
                 order by x.reservado_em desc limit 1) as ultimo_envio
          from oportunidade o
          join empresa e on e.id = o.empresa_id
          ${canalLateral(sql)}
         where o.status in ('nova', 'revisada', 'aprovada_para_contato', 'abordada', 'respondeu', 'reuniao', 'proposta', 'ganha', 'perdida')
           ${q.canal ? sql`and ch.canal = ${q.canal}` : sql``}
      )
      select * from (
        select ops.*, row_number() over (partition by etapa order by lead_score desc nulls last, atualizado_em desc) as rn,
               count(*) over (partition by etapa)::int as total_etapa
          from ops) x
       where rn <= ${q.por_etapa}
       order by etapa, rn`;
    const etapas: Record<string, { total: number; itens: unknown[] }> = {};
    for (const { rn: _rn, total_etapa, ...r } of linhas) {
      const k = r.etapa as string;
      etapas[k] ??= { total: total_etapa as number, itens: [] };
      etapas[k].itens.push(r);
    }
    return { etapas };
  });

  /** Mesmo status para várias oportunidades (ex.: aprovar 5 clínicas com WhatsApp de uma vez). */
  app.post('/oportunidades/status-em-lote', async (req) => {
    const p = z.object({
      ids: z.array(z.string().uuid()).min(1).max(200),
      status: z.enum(['revisada', 'aprovada_para_contato', 'descartada']),
    }).parse(req.body);
    const linhas = await sql`update oportunidade set status = ${p.status}, responsavel = ${req.cliente}
                              where id = any(${p.ids}::uuid[]) and status <> ${p.status}
                                and status in ('nova', 'revisada', 'aprovada_para_contato', 'descartada')
                              returning id`;
    return { atualizadas: linhas.length };
  });

  /** Mudança de status comercial feita por uma pessoa (aprovar para o Neo, descartar...). */
  app.patch('/oportunidades/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = z.object({
      status: z.enum(['nova', 'revisada', 'aprovada_para_contato', 'abordada', 'respondeu', 'reuniao', 'proposta', 'ganha', 'perdida', 'descartada', 'obsoleta']),
      observacao: z.string().max(1000).optional(),
    }).parse(req.body);
    const [o] = await sql`update oportunidade set status = ${p.status}, responsavel = ${req.cliente}
                          where id = ${id} returning id, status, empresa_id`;
    if (!o) return reply.code(404).send({ erro: 'oportunidade não encontrada' });
    if (p.observacao) {
      await sql`insert into interacao (oportunidade_id, canal, direcao, resumo, registrado_por)
                values (${id}, 'outro', 'saida', ${p.observacao}, ${req.cliente})`;
    }
    return o;
  });

  /** Sinal de vida e métricas de um motor (o painel mostra se está rodando, cota de busca web etc.). */
  app.put('/motores/:nome', async (req) => {
    const { nome } = z.object({ nome: z.string().regex(/^[a-z0-9-]{2,40}$/) }).parse(req.params);
    const dados = z.record(z.unknown()).parse(req.body);
    await sql`insert into motor_status (nome, dados) values (${nome}, ${sql.json(dados as never)})
              on conflict (nome) do update set dados = excluded.dados, atualizado_em = now()`;
    return { ok: true };
  });
}
