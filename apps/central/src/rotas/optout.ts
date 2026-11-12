import { OptOut } from '@ionext/contratos';
import { limparCnpj, normalizarEmail, normalizarTelefone } from '@ionext/dominio';
import type { FastifyInstance } from 'fastify';
import type { Sql } from '../db.ts';
import { estaEmOptOut } from '../servicos/oportunidade.ts';

function normalizar(chave: OptOut['chave'], valor: string): string | null {
  if (chave === 'cnpj') return limparCnpj(valor) || null;
  if (chave === 'telefone') return normalizarTelefone(valor);
  if (chave === 'email') return normalizarEmail(valor);
  return valor.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null;
}

export function rotasOptOut(app: FastifyInstance, sql: Sql) {
  /**
   * Registra pedido de oposição ao contato (LGPD) e descarta as oportunidades abertas das empresas afetadas.
   * Status já finalizados (ganha/perdida) não mudam.
   */
  app.post('/opt-out', async (req, reply) => {
    const o = OptOut.parse(req.body);
    const valor = normalizar(o.chave, o.valor);
    if (!valor) return reply.code(400).send({ erro: `valor inválido para ${o.chave}` });

    const afetadas = await sql.begin(async (tx) => {
      await tx`insert into opt_out (chave, valor, motivo) values (${o.chave}, ${valor}, ${o.motivo ?? null})
               on conflict (chave, valor) do nothing`;
      const candidatas = await tx<{ empresa_id: string }[]>`
        select distinct empresa_id from oportunidade where status not in ('ganha', 'perdida', 'descartada')`;
      const ids: string[] = [];
      for (const { empresa_id } of candidatas) {
        if (await estaEmOptOut(tx, empresa_id)) ids.push(empresa_id);
      }
      if (ids.length) {
        await tx`update oportunidade set status = 'descartada'
                  where empresa_id = any(${ids}::uuid[]) and status not in ('ganha', 'perdida')`;
      }
      return ids;
    });
    return reply.code(201).send({ chave: o.chave, valor, empresas_afetadas: afetadas });
  });
}
