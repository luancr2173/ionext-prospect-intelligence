import { DiagnosticoSite } from '@ionext/contratos';
import { classeDosAchados } from '@ionext/dominio';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.ts';
import { recalcularOportunidade } from '../servicos/oportunidade.ts';

/** Dias até uma empresa auditada voltar para a fila (reauditoria automática). */
export const DIAS_REAUDITORIA = 90;
/** Reserva que o motor não devolveu nesse tempo volta para a fila (motor caiu no meio). */
const MINUTOS_RESERVA = 20;

/**
 * Motor 02 · auditoria de sites. A fila mora na Central: o motor reserva trabalho, audita e devolve o
 * diagnóstico (ou a falha, que volta para a fila com espera crescente).
 */
export function rotasAuditorias(app: FastifyInstance, sql: Sql) {
  /** Põe na fila as empresas com site ainda não auditadas (ou auditadas há mais de 90 dias). */
  async function enfileirar() {
    await sql`
      insert into auditoria_pedido (empresa_id, url, motivo)
      select p.empresa_id, p.url_site,
             case when exists (select 1 from auditoria a where a.empresa_id = p.empresa_id) then 'reauditoria' else 'novo' end
        from presenca_digital p
       where p.classificacao in ('SITE_EXISTENTE', 'PRESENCA_FRACA') and p.url_site is not null
         and not exists (select 1 from auditoria a where a.empresa_id = p.empresa_id
                           and a.executada_em > now() - make_interval(days => ${DIAS_REAUDITORIA}))
         and not neo._bloqueada(p.empresa_id)
      on conflict (empresa_id) do nothing`;
  }

  app.post('/auditorias/reservar', async (req) => {
    const { limite } = z.object({ limite: z.number().int().min(1).max(10).default(2) }).parse(req.body ?? {});
    await enfileirar();
    const itens = await sql`
      with c as (
        select empresa_id from auditoria_pedido
         where (reservado_em is null or reservado_em < now() - make_interval(mins => ${MINUTOS_RESERVA}))
           and proxima_tentativa <= now()
         order by (motivo = 'manual') desc, (motivo = 'novo') desc, pedido_em
         limit ${limite}
         for update skip locked)
      update auditoria_pedido p set reservado_em = now(), tentativas = p.tentativas + 1
        from c, empresa e
       where p.empresa_id = c.empresa_id and e.id = p.empresa_id
      returning p.empresa_id, p.url, p.tentativas, p.motivo, e.nome_fantasia`;
    const [fila] = await sql`select count(*)::int as total from auditoria_pedido`;
    return { itens, na_fila: fila!.total };
  });

  /** Diagnóstico do Motor 02: grava evidências e auditoria, tira da fila e recalcula a oportunidade. */
  app.post('/auditorias', async (req, reply) => {
    const d = DiagnosticoSite.parse(req.body);
    const [emp] = await sql`select id from empresa where id = ${d.empresa_id}`;
    if (!emp) return reply.code(404).send({ erro: 'empresa não encontrada' });
    // a Central não confia na classe enviada: recalcula pela mesma regra do domínio
    const classe = classeDosAchados(d.achados);
    const screenshots = [d.psi.mobile?.screenshot, d.psi.desktop?.screenshot].filter((x): x is string => !!x);
    const semPrint = (m: typeof d.psi.mobile) => (m ? { ...m, screenshot: null } : null);

    const id = await sql.begin(async (tx) => {
      const evid: string[] = [];
      if (d.psi.mobile || d.psi.desktop) {
        const [e] = await tx`insert into evidencia (empresa_id, fonte, url, coletado_em, confiabilidade, payload)
          values (${d.empresa_id}, 'pagespeed', ${d.url_final ?? d.url}, ${d.executada_em}, 'alta',
                  ${tx.json({ mobile: semPrint(d.psi.mobile), desktop: semPrint(d.psi.desktop), motor: d.motor } as never)}) returning id`;
        evid.push(e!.id as string);
      }
      const [c] = await tx`insert into evidencia (empresa_id, fonte, url, coletado_em, confiabilidade, payload)
        values (${d.empresa_id}, 'crawler', ${d.url_final ?? d.url}, ${d.executada_em}, 'alta',
                ${tx.json({ paginas: d.paginas, sinais: d.sinais, motor: d.motor } as never)}) returning id`;
      evid.push(c!.id as string);
      const [a] = await tx`
        insert into auditoria (empresa_id, url, url_final, executada_em, motor_versao, psi, achados, pontos_positivos,
                               classe, screenshots, evidencia_ids, resumo, servicos_recomendados, paginas)
        values (${d.empresa_id}, ${d.url}, ${d.url_final}, ${d.executada_em}, ${d.motor},
                ${tx.json({ mobile: semPrint(d.psi.mobile), desktop: semPrint(d.psi.desktop) } as never)},
                ${tx.json(d.achados as never)}, ${tx.json(d.pontos_positivos as never)}, ${classe}, ${screenshots}, ${evid},
                ${d.resumo}, ${d.servicos_recomendados}, ${tx.json(d.paginas as never)})
        returning id`;
      await tx`delete from auditoria_pedido where empresa_id = ${d.empresa_id}`;
      return a!.id as string;
    });
    const r = await recalcularOportunidade(sql, d.empresa_id);
    return { id, classe, oportunidade: r.tipo, lead_score: r.score?.lead_score ?? null };
  });

  /** Falha (PageSpeed sem cota, timeout...): volta para a fila com espera crescente (15 min, 30, 1 h... até 1 dia). */
  app.post('/auditorias/:empresa_id/falha', async (req, reply) => {
    const { empresa_id } = z.object({ empresa_id: z.string().uuid() }).parse(req.params);
    const { erro } = z.object({ erro: z.string().max(500) }).parse(req.body);
    const [p] = await sql`
      update auditoria_pedido set reservado_em = null, ultimo_erro = ${erro},
             proxima_tentativa = now() + least(interval '1 day', interval '15 minutes' * power(2, greatest(tentativas - 1, 0)))
       where empresa_id = ${empresa_id}
      returning empresa_id, tentativas, proxima_tentativa`;
    if (!p) return reply.code(404).send({ erro: 'pedido de auditoria não encontrado' });
    return p;
  });

  /** "Auditar de novo" no painel: entra na frente da fila. */
  app.post('/empresas/:id/auditar', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [p] = await sql`select url_site from presenca_digital where empresa_id = ${id}`;
    if (!p?.url_site) return reply.code(409).send({ erro: 'Esta empresa não tem site para auditar.' });
    const [r] = await sql`
      insert into auditoria_pedido (empresa_id, url, motivo) values (${id}, ${p.url_site}, 'manual')
      on conflict (empresa_id) do update set url = excluded.url, motivo = 'manual', pedido_em = now(),
        reservado_em = null, tentativas = 0, proxima_tentativa = now(), ultimo_erro = null
      returning empresa_id, motivo, pedido_em`;
    return r;
  });
}
