import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.ts';
import {
  calcularValores, dadosDoContrato, gerarDocx, gerarPdf, montarContrato, resumoDoContrato, type DadosContrato, type ItemOrcamento,
} from '../servicos/contrato.ts';

/**
 * Orçamentos salvos (aba Precificação) e contratos.
 * Regra: contrato só sai de orçamento APROVADO, e só com todos os dados obrigatórios; o que faltar volta em "faltando".
 */
const texto = (max: number) => z.string().trim().max(max);
const opcional = (max: number) => texto(max).nullable().optional().transform((v) => (v ? v : null));
const Item = z.object({
  servico_id: z.string().uuid().nullable().optional(),
  nome: texto(160).min(1),
  cobranca: z.enum(['unico', 'mensal', 'anual']),
  unidade: texto(20).nullable().optional(),
  preco: z.number().min(0).max(9_999_999),
  qtd: z.number().int().min(1).max(999),
}).strict();
const Contratante = z.object({
  razao_social: opcional(200), documento: opcional(20), endereco: opcional(300), cidade: opcional(100), uf: opcional(2),
  cep: opcional(10), email: opcional(160), representante_nome: opcional(160), representante_cpf: opcional(20), representante_cargo: opcional(80),
}).strict();
const Condicoes = {
  forma_pagamento: opcional(160),
  condicao_pagamento: opcional(300),
  vencimento_mensal: z.number().int().min(1).max(28).nullable().optional(),
  prazo_entrega_dias: z.number().int().min(1).max(730).nullable().optional(),
  validade: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  fidelidade_meses: z.number().int().min(0).max(60).nullable().optional(),
  observacoes: opcional(1000),
  contratante: Contratante.optional(),
};

const colunas = (sql: Sql) => sql`o.id, o.numero, o.empresa_id, o.oportunidade_id, o.itens, o.desconto, o.status,
  o.valor_unico::float as valor_unico, o.valor_mensal::float as valor_mensal, o.valor_anual::float as valor_anual,
  o.desconto_unico::float as desconto_unico, o.desconto_mensal::float as desconto_mensal,
  o.forma_pagamento, o.condicao_pagamento, o.vencimento_mensal, o.prazo_entrega_dias, o.validade::text as validade,
  o.fidelidade_meses, o.contratante, o.observacoes, o.aprovado_em, o.recusado_em, o.motivo_recusa, o.criado_em, o.atualizado_em,
  e.nome_fantasia, e.razao_social as empresa_razao_social, e.cnpj as empresa_cnpj,
  (select json_build_object('id', c.id, 'numero', c.numero, 'versao', c.versao, 'gerado_em', c.gerado_em)
     from contrato c where c.orcamento_id = o.id) as contrato`;

async function gerarContrato(sql: Sql, id: string) {
  const r = await dadosDoContrato(sql, id);
  if (!r) return { codigo: 404 as const, corpo: { erro: 'orçamento não encontrado' } };
  if (r.status !== 'aprovado') {
    return { codigo: 409 as const, corpo: { erro: `Contrato só é gerado para orçamento aprovado. Este está "${r.status}".`, status: r.status } };
  }
  if (r.faltando.length) {
    return { codigo: 422 as const, corpo: { erro: 'Faltam dados obrigatórios para gerar o contrato.', faltando: r.faltando } };
  }
  const [c] = await sql`
    insert into contrato (orcamento_id, numero, dados) values (${id}, ${r.dados.numero}, ${sql.json(r.dados as never)})
    on conflict (orcamento_id) do update set dados = excluded.dados, versao = contrato.versao + 1, gerado_em = now()
    returning id, numero, versao, gerado_em`;
  return { codigo: 200 as const, corpo: { contrato: c, ...resumoDoContrato(r.dados) } };
}

export function rotasOrcamentos(app: FastifyInstance, sql: Sql) {
  // ---- dados da IONEXT (contratada)
  app.get('/ionext-dados', async () => {
    const [d] = await sql`select * from ionext_dados where id = 1`;
    return d ?? {};
  });
  app.put('/ionext-dados', async (req) => {
    const p = z.object({
      razao_social: opcional(200), nome_fantasia: opcional(120), cnpj: opcional(20), endereco: opcional(300), cidade: opcional(100),
      uf: opcional(2), cep: opcional(10), email: opcional(160), telefone: opcional(30), representante_nome: opcional(160),
      representante_cpf: opcional(20), representante_cargo: opcional(80), foro_cidade: opcional(100), foro_uf: opcional(2),
    }).strict().parse(req.body);
    const campos = { ...p, nome_fantasia: p.nome_fantasia ?? 'IONEXT', uf: p.uf?.toUpperCase() ?? null, foro_uf: p.foro_uf?.toUpperCase() ?? null };
    const [d] = await sql`insert into ionext_dados ${sql({ id: 1, ...campos })}
                          on conflict (id) do update set ${sql(campos)}, atualizado_em = now() returning *`;
    return d;
  });

  // ---- orçamentos
  app.get('/orcamentos', async (req) => {
    const q = z.object({
      empresa_id: z.string().uuid().optional(),
      status: z.enum(['pendente', 'aprovado', 'recusado']).optional(),
    }).parse(req.query);
    return sql`select ${colunas(sql)} from orcamento o join empresa e on e.id = o.empresa_id
                where true ${q.empresa_id ? sql`and o.empresa_id = ${q.empresa_id}` : sql``}
                ${q.status ? sql`and o.status = ${q.status}` : sql``}
                order by case o.status when 'pendente' then 0 when 'aprovado' then 1 else 2 end, o.criado_em desc limit 100`;
  });

  app.get('/orcamentos/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [o] = await sql`select ${colunas(sql)}, e.endereco as empresa_endereco, e.bairro as empresa_bairro, e.cidade as empresa_cidade,
                                 e.uf as empresa_uf, e.cep as empresa_cep
                            from orcamento o join empresa e on e.id = o.empresa_id where o.id = ${id}`;
    if (!o) return reply.code(404).send({ erro: 'orçamento não encontrado' });
    const r = await dadosDoContrato(sql, id);
    return { ...o, faltando: r?.faltando ?? [] };
  });

  /** Salva o orçamento montado na Precificação. Os totais são recalculados aqui; a descrição vem do catálogo. */
  app.post('/orcamentos', async (req, reply) => {
    const p = z.object({
      oportunidade_id: z.string().uuid().optional(),
      empresa_id: z.string().uuid().optional(),
      itens: z.array(Item).min(1).max(40),
      desconto: z.object({ tipo: z.enum(['pct', 'valor']).default('pct'), valor: z.number().min(0).max(9_999_999).default(0), mensal: z.boolean().default(false) }).strict().default({}),
      ...Condicoes,
    }).strict().refine((x) => x.oportunidade_id || x.empresa_id, 'informe a oportunidade ou a empresa').parse(req.body);
    let empresaId = p.empresa_id ?? null;
    if (p.oportunidade_id) {
      const [op] = await sql`select empresa_id from oportunidade where id = ${p.oportunidade_id}`;
      if (!op) return reply.code(404).send({ erro: 'oportunidade não encontrada' });
      if (empresaId && empresaId !== op.empresa_id) return reply.code(400).send({ erro: 'a oportunidade é de outra empresa' });
      empresaId = op.empresa_id;
    }
    const [emp] = await sql`select id from empresa where id = ${empresaId}`;
    if (!emp) return reply.code(404).send({ erro: 'empresa não encontrada' });
    const ids = p.itens.map((i) => i.servico_id).filter(Boolean) as string[];
    const cat = ids.length ? await sql`select id, chave, descricao, unidade from servico where id = any(${ids})` : [];
    const porId = new Map(cat.map((s) => [s.id as string, s]));
    const itens: ItemOrcamento[] = p.itens.map((i) => {
      const s = i.servico_id ? porId.get(i.servico_id) : undefined;
      return { servico_id: i.servico_id ?? null, chave: (s?.chave as string) ?? null, nome: i.nome, descricao: (s?.descricao as string) ?? null,
        cobranca: i.cobranca, unidade: i.unidade ?? (s?.unidade as string) ?? null, preco: i.preco, qtd: i.qtd };
    });
    const v = calcularValores(itens, p.desconto);
    const [o] = await sql`
      insert into orcamento (empresa_id, oportunidade_id, itens, desconto, valor_unico, valor_mensal, valor_anual, desconto_unico,
                             desconto_mensal, forma_pagamento, condicao_pagamento, vencimento_mensal, prazo_entrega_dias, validade,
                             fidelidade_meses, observacoes, contratante)
      values (${empresaId}, ${p.oportunidade_id ?? null}, ${sql.json(itens as never)}, ${sql.json(p.desconto)}, ${v.valor_unico},
              ${v.valor_mensal}, ${v.valor_anual}, ${v.desconto_unico}, ${v.desconto_mensal}, ${p.forma_pagamento ?? null},
              ${p.condicao_pagamento ?? null}, ${p.vencimento_mensal ?? null}, ${p.prazo_entrega_dias ?? null},
              ${p.validade ?? sql`(now() at time zone 'America/Sao_Paulo')::date + 15`}, ${p.fidelidade_meses ?? null},
              ${p.observacoes ?? null}, ${sql.json((p.contratante ?? {}) as never)})
      returning id`;
    const [criado] = await sql`select ${colunas(sql)} from orcamento o join empresa e on e.id = o.empresa_id where o.id = ${o!.id}`;
    return reply.code(201).send(criado);
  });

  /** Completa condições e dados do cliente. Orçamento aprovado também pode ser completado (para gerar o contrato). */
  app.patch('/orcamentos/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = z.object(Condicoes).strict().parse(req.body);
    const campos = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as Record<string, unknown>;
    if (campos.contratante) campos.contratante = sql.json(campos.contratante as never);
    if (Object.keys(campos).length === 0) return reply.code(400).send({ erro: 'nada para atualizar' });
    const [o] = await sql`update orcamento set ${sql(campos as never)}, atualizado_em = now() where id = ${id} returning id`;
    if (!o) return reply.code(404).send({ erro: 'orçamento não encontrado' });
    const [r] = await sql`select ${colunas(sql)} from orcamento o join empresa e on e.id = o.empresa_id where o.id = ${id}`;
    return { ...r, faltando: (await dadosDoContrato(sql, id))?.faltando ?? [] };
  });

  /**
   * Aprovar / recusar / voltar para pendente. Ao aprovar, o contrato é gerado na hora;
   * se faltar dado, o orçamento fica aprovado e a resposta traz o que falta.
   */
  app.post('/orcamentos/:id/status', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = z.object({ status: z.enum(['pendente', 'aprovado', 'recusado']), motivo: opcional(300) }).strict().parse(req.body);
    const [o] = await sql`
      update orcamento set status = ${p.status},
             aprovado_em = case when ${p.status} = 'aprovado' then coalesce(aprovado_em, now()) when ${p.status} = 'pendente' then null else aprovado_em end,
             recusado_em = case when ${p.status} = 'recusado' then now() else null end,
             motivo_recusa = case when ${p.status} = 'recusado' then ${p.motivo ?? null} else null end,
             atualizado_em = now()
       where id = ${id} returning id`;
    if (!o) return reply.code(404).send({ erro: 'orçamento não encontrado' });
    const [orc] = await sql`select ${colunas(sql)} from orcamento o join empresa e on e.id = o.empresa_id where o.id = ${id}`;
    if (p.status !== 'aprovado') return { orcamento: orc };
    const g = await gerarContrato(sql, id);
    return reply.code(200).send({ orcamento: orc, ...(g.codigo === 200 ? g.corpo : { faltando: (g.corpo as { faltando?: unknown }).faltando ?? [] }) });
  });

  /** Gera (ou gera de novo, com os dados atuais) o contrato. */
  app.post('/orcamentos/:id/contrato', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const g = await gerarContrato(sql, id);
    return reply.code(g.codigo).send(g.corpo);
  });

  // ---- arquivos do contrato
  const enviar = async (reply: FastifyReply, id: string, formato: 'docx' | 'pdf') => {
    const [c] = await sql`select c.numero, c.dados, o.status from contrato c join orcamento o on o.id = c.orcamento_id where c.id = ${id}`;
    if (!c) return reply.code(404).send({ erro: 'contrato não encontrado' });
    if (c.status !== 'aprovado') return reply.code(409).send({ erro: 'o orçamento deste contrato não está mais aprovado' });
    const modelo = montarContrato(c.dados as DadosContrato);
    const corpo = formato === 'docx' ? await gerarDocx(modelo) : await gerarPdf(modelo);
    const tipo = formato === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf';
    return reply.header('content-type', tipo)
      .header('content-disposition', `attachment; filename="Contrato-${c.numero}.${formato}"`)
      .header('cache-control', 'no-store')
      .send(corpo);
  };
  app.get('/contratos/:id/docx', async (req, reply) => enviar(reply, z.object({ id: z.string().uuid() }).parse(req.params).id, 'docx'));
  app.get('/contratos/:id/pdf', async (req, reply) => enviar(reply, z.object({ id: z.string().uuid() }).parse(req.params).id, 'pdf'));
}
