/**
 * V5 — busca web gratuita em cadeia: Tavily (1.000/mês grátis) → Exa (crédito mensal grátis) → fila do Claude.
 * Nunca passa da cota gratuita: o uso é contado em motor.uso_busca_web e o provedor é pulado ao atingir o limite.
 */
import type { Sql } from '../db.ts';
import type { Rede } from '../http.ts';

export interface ResultadoBusca { url: string; titulo: string; trecho: string }

export interface ProvedorBusca {
  nome: string;
  limiteMensal: number;
  buscar(consulta: string): Promise<ResultadoBusca[]>;
}

export class CotaEsgotada extends Error {}

export function tavily(rede: Rede, apiKey: string, limiteMensal: number): ProvedorBusca {
  return {
    nome: 'tavily',
    limiteMensal,
    async buscar(consulta) {
      const r = await rede.postJson('https://api.tavily.com/search',
        { query: consulta, search_depth: 'basic', max_results: 10 },
        { authorization: `Bearer ${apiKey}` });
      if (r.status === 429 || r.status === 432 || r.status === 433) throw new CotaEsgotada(`tavily HTTP ${r.status}`);
      if (r.status !== 200) throw new Error(`tavily HTTP ${r.status}`);
      const j = r.json as { results?: { url: string; title?: string; content?: string }[] };
      return (j.results ?? []).map((x) => ({ url: x.url, titulo: x.title ?? '', trecho: x.content ?? '' }));
    },
  };
}

export function exa(rede: Rede, apiKey: string, limiteMensal: number, tipo: string): ProvedorBusca {
  return {
    nome: 'exa',
    limiteMensal,
    async buscar(consulta) {
      const r = await rede.postJson('https://api.exa.ai/search',
        { query: consulta, type: tipo, numResults: 10 },
        { 'x-api-key': apiKey });
      if (r.status === 402 || r.status === 429) throw new CotaEsgotada(`exa HTTP ${r.status}`);
      if (r.status !== 200) throw new Error(`exa HTTP ${r.status}`);
      const j = r.json as { results?: { url: string; title?: string; text?: string }[] };
      return (j.results ?? []).map((x) => ({ url: x.url, titulo: x.title ?? '', trecho: x.text ?? '' }));
    },
  };
}

function mesAtual(agora = new Date()): string {
  return agora.toISOString().slice(0, 7);
}

/** Reserva 1 consulta na cota do mês; false se o limite já foi atingido. Atômico. */
async function reservar(sql: Sql, provedor: string, limite: number): Promise<boolean> {
  const mes = mesAtual();
  const r = await sql`
    insert into motor.uso_busca_web (provedor, mes, consultas) values (${provedor}, ${mes}, 1)
    on conflict (provedor, mes) do update set consultas = motor.uso_busca_web.consultas + 1
      where motor.uso_busca_web.consultas < ${limite}
    returning consultas`;
  return r.count > 0;
}

/** Marca a cota como esgotada (o provedor respondeu que acabou antes do nosso contador). */
async function esgotar(sql: Sql, provedor: string, limite: number) {
  await sql`update motor.uso_busca_web set consultas = greatest(consultas, ${limite})
             where provedor = ${provedor} and mes = ${mesAtual()}`;
}

export type SaidaBuscaWeb =
  | { tipo: 'resultados'; provedor: string; consulta: string; resultados: ResultadoBusca[] }
  | { tipo: 'enfileirado_claude'; consulta: string }
  | { tipo: 'erro'; detalhe: string };

export interface ContextoFila {
  cnpj: string;
  busca_id: string | null;
  prioridade: number;
  contexto: Record<string, unknown>;
}

export async function buscarNaWeb(sql: Sql, provedores: ProvedorBusca[], consulta: string, fila: ContextoFila): Promise<SaidaBuscaWeb> {
  // Cache de 30 dias: reprocessar não gasta cota
  const [cache] = await sql<{ provedor: string; resultados: ResultadoBusca[] }[]>`
    select provedor, resultados from motor.cache_busca_web
     where consulta = ${consulta} and criado_em > now() - interval '30 days'`;
  if (cache) return { tipo: 'resultados', provedor: `cache:${cache.provedor}`, consulta, resultados: cache.resultados };

  const erros: string[] = [];
  for (const p of provedores) {
    if (!(await reservar(sql, p.nome, p.limiteMensal))) continue;
    try {
      const resultados = await p.buscar(consulta);
      await sql`insert into motor.cache_busca_web (consulta, provedor, resultados)
                values (${consulta}, ${p.nome}, ${sql.json(resultados as never)})
                on conflict (consulta) do update set provedor = excluded.provedor, resultados = excluded.resultados, criado_em = now()`;
      return { tipo: 'resultados', provedor: p.nome, consulta, resultados };
    } catch (e) {
      if (e instanceof CotaEsgotada) { await esgotar(sql, p.nome, p.limiteMensal); continue; }
      erros.push(`${p.nome}: ${(e as Error).message}`);
    }
  }
  if (erros.length && provedores.length > 0) {
    // Falha transitória de um provedor com cota: tenta de novo depois (retentativa do job), não gasta o Claude.
    return { tipo: 'erro', detalhe: erros.join('; ') };
  }
  await sql`
    insert into motor.fila_busca_web (cnpj, busca_id, consulta, contexto, prioridade)
    values (${fila.cnpj}, ${fila.busca_id}, ${consulta}, ${sql.json(fila.contexto as never)}, ${fila.prioridade})
    on conflict (cnpj) where status in ('pendente', 'em_andamento') do nothing`;
  return { tipo: 'enfileirado_claude', consulta };
}

/** Resultado que o Claude grava em motor.fila_busca_web.resultado */
export interface ResultadoClaude {
  urls: { url: string; observacao?: string }[];
  observacao?: string;
  pesquisado_em: string;
}

export function consultaPara(nome: string, bairro: string | null, cidade: string): string {
  return `"${nome}" ${bairro ?? ''} ${cidade}`.replace(/\s+/g, ' ').trim();
}
