import { normalizarNome, segmentoPorCnae, segmentoPorId } from '@ionext/dominio';
import { VERSAO_MOTOR, type ConfigMotor } from '../config.ts';
import type { Sql } from '../db.ts';
import type { Rede } from '../http.ts';
import type { ProvedorBusca, ResultadoClaude } from '../verificadores/buscaWeb.ts';
import { atualizarCatalogoOsm, carregarCatalogo } from '../verificadores/osm.ts';
import type { ClienteCentral } from './central.ts';
import { processarEstabelecimento, type Estabelecimento } from './processar.ts';

export interface Contexto {
  sql: Sql;
  rede: Rede;
  central: ClienteCentral;
  provedores: ProvedorBusca[];
  config: ConfigMotor;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface JobVerificar { busca_id: string | null; cnpj: string; uf: string; segmento: string }

/** Seleciona os estabelecimentos da busca e devolve os jobs a enfileirar. */
export async function planejarBusca(ctx: Contexto, buscaId: string): Promise<JobVerificar[]> {
  const busca = await ctx.central.obterBusca(buscaId);
  const f = busca.filtros;
  const seg = segmentoPorId(f.segmento);
  if (!seg) throw new Error(`segmento desconhecido: ${f.segmento}`);
  const cnaes = f.cnaes.length ? f.cnaes : seg.cnaes;
  const uf = f.uf.toUpperCase();

  // Catálogo OSM do segmento (uma consulta por segmento/UF). Falha não impede a busca: V2 fica pendente.
  try {
    const n = await atualizarCatalogoOsm(ctx.sql, ctx.rede, uf, seg);
    ctx.log(n >= 0 ? `catálogo OSM ${seg.id}/${uf}: ${n} POIs` : `catálogo OSM ${seg.id}/${uf} recente, mantido`);
  } catch (e) {
    ctx.log(`catálogo OSM indisponível: ${(e as Error).message}`);
  }

  const bairros = f.bairros.map((b) => `%${normalizarNome(b)}%`);
  const portes = f.portes.filter((p) => p !== 'MEI');
  const incluiMei = f.portes.length === 0 || f.portes.includes('MEI');
  const linhas = await ctx.sql<{ cnpj: string }[]>`
    select e.cnpj from receita.estabelecimento e
      left join motor.empresa_processada p on p.cnpj = e.cnpj
     where e.uf = ${uf}
       and lower(extensions.unaccent(e.municipio_nome)) = ${f.cidade.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()}
       and e.cnae_principal = any(${cnaes}::text[])
       and e.situacao = 'ATIVA'
       ${bairros.length ? ctx.sql`and e.bairro_normalizado like any(${bairros}::text[])` : ctx.sql``}
       ${f.portes.length ? ctx.sql`and ((e.mei is true and ${incluiMei}) or (coalesce(e.mei, false) is false and e.porte = any(${portes}::text[])))` : ctx.sql``}
       and (p.processado_em is null or p.processado_em < now() - make_interval(days => ${ctx.config.diasReprocessamento}))
     order by e.matriz desc, e.data_inicio nulls last, e.cnpj
     limit ${f.quantidade_desejada}`;

  await ctx.sql`insert into motor.busca_progresso (busca_id, total) values (${buscaId}, ${linhas.length})
                on conflict (busca_id) do update set total = excluded.total, processadas = 0, falhas = 0, atualizado_em = now()`;
  await ctx.central.atualizarBusca(buscaId, { status: linhas.length ? 'executando' : 'concluida', total_celulas: linhas.length, concluidas: 0 });
  ctx.log(`busca ${buscaId}: ${linhas.length} estabelecimentos planejados`);
  return linhas.map((l) => ({ busca_id: buscaId, cnpj: l.cnpj, uf, segmento: seg.id }));
}

async function carregarEstabelecimento(sql: Sql, cnpj: string): Promise<Estabelecimento | null> {
  const [e] = await sql<Estabelecimento[]>`
    select cnpj, nome_fantasia, razao_social, situacao, to_char(data_inicio, 'YYYY-MM-DD') as data_inicio, cnae_principal,
           logradouro, bairro, cep, uf, municipio_nome, telefones, email, porte, mei, referencia
      from receita.estabelecimento where cnpj = ${cnpj}`;
  return e ?? null;
}

/** Processa uma empresa e entrega à Central. Lança em falha transitória (o job é refeito com backoff). */
export async function verificarEmpresa(ctx: Contexto, job: JobVerificar, resultadoClaude: ResultadoClaude | null = null) {
  const e = await carregarEstabelecimento(ctx.sql, job.cnpj);
  if (!e) { ctx.log(`cnpj ${job.cnpj} não está mais na base`); return null; }
  const catalogo = await carregarCatalogo(ctx.sql, job.uf, job.segmento);

  const saida = await processarEstabelecimento(
    { sql: ctx.sql, rede: ctx.rede, provedores: ctx.provedores, config: ctx.config, catalogoOsm: catalogo },
    e, { busca_id: job.busca_id, resultadoClaude },
  );
  const resp = await ctx.central.enviar([saida.candidata], job.busca_id);
  const r = resp.resultados[0];
  if (r?.acao === 'erro') throw new Error(`Central recusou ${job.cnpj}: ${r.avisos.join('; ')}`);

  await ctx.sql`insert into motor.empresa_processada (cnpj, processado_em, resultado)
                values (${job.cnpj}, now(), ${ctx.sql.json({ ...r, busca_web: saida.buscaWeb } as never)})
                on conflict (cnpj) do update set processado_em = now(), resultado = excluded.resultado`;
  ctx.log(`${job.cnpj} → ${r?.acao} ${r?.classificacao ?? ''} score=${r?.lead_score ?? '-'} busca_web=${saida.buscaWeb}`);
  return { ...r, busca_web: saida.buscaWeb };
}

export async function registrarProgresso(ctx: Contexto, buscaId: string | null, ok: boolean) {
  if (!buscaId) return;
  const [p] = await ctx.sql<{ total: number; processadas: number; falhas: number }[]>`
    update motor.busca_progresso
       set processadas = processadas + ${ok ? 1 : 0}, falhas = falhas + ${ok ? 0 : 1}, atualizado_em = now()
     where busca_id = ${buscaId} returning total, processadas, falhas`;
  if (!p) return;
  const feitas = p.processadas + p.falhas;
  if (feitas >= p.total) {
    await ctx.central.atualizarBusca(buscaId, { status: 'concluida', concluidas: p.processadas });
    ctx.log(`busca ${buscaId} concluída: ${p.processadas} ok, ${p.falhas} falhas`);
  } else if (feitas % 25 === 0) {
    await ctx.central.atualizarBusca(buscaId, { concluidas: p.processadas });
  }
}

/** Consome resultados que o Claude gravou na fila e reprocessa essas empresas. */
export async function consumirFilaClaude(ctx: Contexto, limite = 50): Promise<number> {
  const itens = await ctx.sql<{ id: string; cnpj: string; busca_id: string | null; resultado: ResultadoClaude }[]>`
    select id, cnpj, busca_id, resultado from motor.fila_busca_web
     where status = 'concluida' and processado_em is null and resultado is not null
     order by concluido_em limit ${limite}`;
  let n = 0;
  for (const it of itens) {
    const [e] = await ctx.sql<{ uf: string; cnae_principal: string }[]>`select uf, cnae_principal from receita.estabelecimento where cnpj = ${it.cnpj}`;
    const seg = e ? segmentoPorCnae(e.cnae_principal) : undefined;
    if (e && seg) {
      try {
        await verificarEmpresa(ctx, { busca_id: it.busca_id, cnpj: it.cnpj, uf: e.uf, segmento: seg.id }, it.resultado);
        n++;
      } catch (err) {
        ctx.log(`fila Claude ${it.cnpj}: ${(err as Error).message}`);
        continue;
      }
    }
    await ctx.sql`update motor.fila_busca_web set processado_em = now() where id = ${it.id}`;
  }
  // Itens pegos pelo Claude e abandonados há mais de 6 h voltam para a fila
  await ctx.sql`update motor.fila_busca_web set status = 'pendente', pego_em = null
                 where status = 'em_andamento' and pego_em < now() - interval '6 hours'`;
  return n;
}

/** Empresas de uma busca já feita, para verificar de novo com as regras atuais (a busca web usa o cache). */
export async function prepararReprocesso(ctx: Contexto, buscaId: string): Promise<JobVerificar[]> {
  const linhas = await ctx.sql<{ cnpj: string; uf: string; cnae_principal: string }[]>`
    select e.cnpj, r.uf, r.cnae_principal from busca_resultado br
      join empresa e on e.id = br.empresa_id
      join receita.estabelecimento r on r.cnpj = e.cnpj
     where br.busca_id = ${buscaId}`;
  const jobs = linhas.flatMap((l) => {
    const seg = segmentoPorCnae(l.cnae_principal);
    return seg ? [{ busca_id: buscaId, cnpj: l.cnpj, uf: l.uf, segmento: seg.id }] : [];
  });
  await ctx.sql`insert into motor.busca_progresso (busca_id, total) values (${buscaId}, ${jobs.length})
                on conflict (busca_id) do update set total = excluded.total, processadas = 0, falhas = 0, atualizado_em = now()`;
  await ctx.central.atualizarBusca(buscaId, { status: jobs.length ? 'executando' : 'concluida', concluidas: 0 });
  ctx.log(`busca ${buscaId}: ${jobs.length} empresas enviadas para reprocessar`);
  return jobs;
}

/** Métricas que o painel mostra: cota da busca web no mês, fila do Claude, base carregada. */
export async function metricasMotor(ctx: Contexto) {
  const [base] = await ctx.sql`select count(*)::int as estabelecimentos, max(referencia) as referencia from receita.estabelecimento`;
  const cota = await ctx.sql`select provedor, consultas from motor.uso_busca_web where mes = to_char(now(), 'YYYY-MM')`;
  const fila = await ctx.sql`select status, count(*)::int as total from motor.fila_busca_web group by status`;
  return {
    versao: VERSAO_MOTOR,
    base_receita: base,
    busca_web: ctx.provedores.map((p) => ({ provedor: p.nome, limite: p.limiteMensal, usadas: cota.find((c) => c.provedor === p.nome)?.consultas ?? 0 })),
    fila_claude: Object.fromEntries(fila.map((f) => [f.status, f.total])),
    concorrencia: ctx.config.concorrencia,
  };
}
