import { OptOut } from '@ionext/contratos';
import { limparCnpj, normalizarEmail, normalizarTelefone } from '@ionext/dominio';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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

  /**
   * "Não contatar" pela ficha: bloqueia a empresa inteira (CNPJ, todos os telefones e e-mails dela),
   * descarta as oportunidades abertas e deixa registrado na linha do tempo. Devolve o que foi bloqueado,
   * para o painel mostrar a confirmação.
   */
  app.post('/empresas/:id/nao-contatar', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = z.object({ motivo: z.string().trim().max(300).optional() }).strict().parse(req.body ?? {});
    const motivo = p.motivo || 'pediu para não ser contatada (registrado no painel)';
    const r = await sql.begin(async (tx) => {
      const [emp] = await tx`select id, cnpj, nome_fantasia from empresa where id = ${id}`;
      if (!emp) return null;
      const chaves: { chave: string; valor: string }[] = [];
      if (emp.cnpj) chaves.push({ chave: 'cnpj', valor: emp.cnpj as string });
      const contatos = await tx`select distinct tipo, valor_normalizado from contato
                                 where empresa_id = ${id} and tipo in ('telefone', 'whatsapp', 'email') and valor_normalizado is not null`;
      for (const c of contatos) chaves.push({ chave: c.tipo === 'email' ? 'email' : 'telefone', valor: c.valor_normalizado as string });
      const unicas = [...new Map(chaves.map((c) => [`${c.chave}:${c.valor}`, c])).values()];
      if (unicas.length === 0) return { sem_chave: true as const };
      for (const c of unicas) {
        await tx`insert into opt_out (chave, valor, motivo) values (${c.chave}, ${c.valor}, ${motivo}) on conflict (chave, valor) do nothing`;
      }
      const abertas = await tx`select id from oportunidade where empresa_id = ${id} and status not in ('ganha', 'perdida', 'descartada')`;
      if (abertas.length) {
        await tx`update oportunidade set status = 'descartada', responsavel = ${req.cliente} where id = any(${abertas.map((o) => o.id)}::uuid[])`;
      }
      const todas = await tx`select id from oportunidade where empresa_id = ${id}`;
      for (const o of todas) {
        await tx`insert into interacao (oportunidade_id, canal, direcao, resumo, registrado_por)
                 values (${o.id}, 'outro', 'saida', ${`Não contatar: ${motivo}. A empresa saiu de todas as filas.`}, ${req.cliente})`;
      }
      // outras empresas com o mesmo telefone/e-mail também ficam bloqueadas: descarta as abertas delas
      const outras = await tx<{ empresa_id: string }[]>`
        select distinct empresa_id from oportunidade where empresa_id <> ${id} and status not in ('ganha', 'perdida', 'descartada')`;
      let outrasAfetadas = 0;
      for (const { empresa_id } of outras) {
        if (await estaEmOptOut(tx, empresa_id)) {
          await tx`update oportunidade set status = 'descartada' where empresa_id = ${empresa_id} and status not in ('ganha', 'perdida')`;
          outrasAfetadas++;
        }
      }
      return { nome: emp.nome_fantasia as string, bloqueados: unicas, oportunidades_descartadas: abertas.length, outras_empresas: outrasAfetadas };
    });
    if (!r) return reply.code(404).send({ erro: 'empresa não encontrada' });
    if ('sem_chave' in r) return reply.code(422).send({ erro: 'Esta empresa não tem CNPJ, telefone nem e-mail para bloquear.' });
    return reply.code(201).send(r);
  });
}
