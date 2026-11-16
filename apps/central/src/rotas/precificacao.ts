import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.ts';

const CATEGORIAS = ['sites', 'sistemas', 'ia_automacao', 'presenca', 'avulso'] as const;
const COBRANCAS = ['unico', 'mensal', 'anual'] as const;
const UNIDADES = ['projeto', 'mes', 'ano', 'hora', 'pagina', 'fluxo'] as const;
const preco = z.number().min(0).max(9_999_999);

const colunas = (sql: Sql) => sql`id, chave, nome, categoria, cobranca, unidade, descricao, preco::float as preco,
  faixa_min::float as faixa_min, faixa_max::float as faixa_max, nota_mercado, fontes, ordem, ativo`;

/**
 * Precificação: catálogo de serviços (faixa de mercado com fonte + preço da IONEXT, editável) e a lista
 * de oportunidades em andamento para levar um orçamento para a proposta.
 */
export function rotasPrecificacao(app: FastifyInstance, sql: Sql) {
  app.get('/servicos', async (req) => {
    const q = z.object({ todos: z.coerce.boolean().default(false) }).parse(req.query);
    return sql`select ${colunas(sql)} from servico ${q.todos ? sql`` : sql`where ativo`} order by ordem, nome`;
  });

  /** Serviço novo criado no painel (ex.: "Cardápio digital"). Sem faixa de mercado: não há pesquisa por trás. */
  app.post('/servicos', async (req, reply) => {
    const p = z.object({
      nome: z.string().trim().min(1).max(120),
      categoria: z.enum(CATEGORIAS).default('avulso'),
      cobranca: z.enum(COBRANCAS).default('unico'),
      unidade: z.enum(UNIDADES).default('projeto'),
      descricao: z.string().trim().max(400).optional(),
      preco,
    }).strict().parse(req.body);
    const [s] = await sql`insert into servico (nome, categoria, cobranca, unidade, descricao, preco, ordem)
                          values (${p.nome}, ${p.categoria}, ${p.cobranca}, ${p.unidade}, ${p.descricao || null}, ${p.preco}, 900)
                          returning ${colunas(sql)}`;
    return reply.code(201).send(s);
  });

  /** Ajusta o preço da IONEXT, o nome/descrição ou tira do catálogo (ativo=false). A faixa de mercado não muda por aqui. */
  app.patch('/servicos/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = z.object({
      nome: z.string().trim().min(1).max(120).optional(),
      descricao: z.string().trim().max(400).nullable().optional(),
      preco: preco.optional(),
      ativo: z.boolean().optional(),
    }).strict().parse(req.body);
    const campos = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
    if (Object.keys(campos).length === 0) return reply.code(400).send({ erro: 'nada para atualizar' });
    const [s] = await sql`update servico set ${sql(campos)}, atualizado_em = now() where id = ${id} returning ${colunas(sql)}`;
    if (!s) return reply.code(404).send({ erro: 'serviço não encontrado' });
    return s;
  });

  /** Oportunidades em conversa (para escolher onde gravar o orçamento). */
  app.get('/painel/oportunidades-abertas', async (req) => {
    const q = z.object({ busca: z.string().trim().max(80).optional() }).parse(req.query);
    return sql`
      select o.id, o.status, o.proposta_valor::float as proposta_valor, o.proposta_solucao,
             e.nome_fantasia, e.bairro, e.segmento
        from oportunidade o join empresa e on e.id = o.empresa_id
       where o.status in ('abordada', 'respondeu', 'reuniao', 'proposta', 'aprovada_para_contato', 'revisada', 'nova')
         ${q.busca ? sql`and e.nome_fantasia ilike ${`%${q.busca.replace(/[%_\\]/g, (c) => `\\${c}`)}%`}` : sql``}
       order by case o.status when 'proposta' then 0 when 'reuniao' then 1 when 'respondeu' then 2 when 'abordada' then 3 else 4 end,
                o.atualizado_em desc
       limit 30`;
  });
}
