/**
 * CLI do Motor 01.
 *   carregar-receita --dir ./dados-receita --referencia 2026-10 --uf DF --municipio BRASILIA [--segmentos clinica_odontologica,academia]
 *   buscar --segmento clinica_odontologica --uf DF --cidade Brasilia --bairros "Asa Norte,Taguatinga,Aguas Claras" --quantidade 300
 *   worker
 *   processar --cnpj 11222333000181 [--enviar]
 *   status
 */
import { parseArgs } from 'node:util';
import PgBoss from 'pg-boss';
import { SEGMENTOS, TODOS_CNAES_ALVO, carregarEnv, segmentoPorCnae, segmentoPorId } from '@ionext/dominio';
import { lerConfigMotor } from './config.ts';
import { conectar } from './db.ts';
import { redeReal } from './http.ts';
import { ClienteCentral } from './pipeline/central.ts';
import {
  consumirFilaClaude, metricasMotor, planejarBusca, prepararReprocesso, registrarProgresso, verificarEmpresa,
  type Contexto, type JobVerificar,
} from './pipeline/orquestracao.ts';
import { processarEstabelecimento } from './pipeline/processar.ts';
import { carregarReceita } from './receita/etl.ts';
import { exa, tavily, type ProvedorBusca } from './verificadores/buscaWeb.ts';
import { carregarCatalogo } from './verificadores/osm.ts';

const FILA_PLANEJAR = 'busca-planejar';
const FILA_VERIFICAR = 'empresa-verificar';
const FILA_CLAUDE = 'fila-claude-consumir';

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

function contexto(): Contexto {
  const config = lerConfigMotor();
  const sql = conectar(config.databaseUrl);
  const rede = redeReal(config.userAgent);
  const provedores: ProvedorBusca[] = [];
  if (config.tavilyApiKey) provedores.push(tavily(rede, config.tavilyApiKey, config.tavilyLimiteMensal));
  if (config.exaApiKey) provedores.push(exa(rede, config.exaApiKey, config.exaLimiteMensal, config.exaTipo));
  return { sql, rede, central: new ClienteCentral(config.centralUrl, config.centralApiKey), provedores, config, log };
}

async function boss(databaseUrl: string) {
  const b = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss' });
  b.on('error', (e) => log(`pg-boss: ${e.message}`));
  await b.start();
  for (const q of [FILA_PLANEJAR, FILA_VERIFICAR, FILA_CLAUDE]) await b.createQueue(q);
  return b;
}

async function main() {
  carregarEnv();
  const [comando, ...resto] = process.argv.slice(2);
  const { values: a } = parseArgs({
    args: resto, strict: false,
    options: {
      dir: { type: 'string' }, referencia: { type: 'string' }, uf: { type: 'string' }, municipio: { type: 'string' },
      segmentos: { type: 'string' }, segmento: { type: 'string' }, cidade: { type: 'string' }, bairros: { type: 'string' },
      portes: { type: 'string' }, quantidade: { type: 'string' }, cnpj: { type: 'string' }, enviar: { type: 'boolean' },
    },
  });
  const s = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined);

  if (comando === 'carregar-receita') {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL não definida');
    const sql = conectar(databaseUrl);
    const segs = s('segmentos') ? s('segmentos')!.split(',').map((id) => {
      const seg = segmentoPorId(id.trim()); if (!seg) throw new Error(`segmento ${id}?`); return seg;
    }) : SEGMENTOS;
    const r = await carregarReceita(sql, {
      diretorio: s('dir') ?? './dados-receita', referencia: s('referencia') ?? (() => { throw new Error('--referencia AAAA-MM'); })(),
      uf: s('uf') ?? 'DF', municipio: s('municipio') ?? 'BRASILIA',
      cnaes: segs === SEGMENTOS ? TODOS_CNAES_ALVO : [...new Set(segs.flatMap((x) => x.cnaes))], log,
    });
    console.log(JSON.stringify(r, null, 2));
    await sql.end();
    return;
  }

  const ctx = contexto();

  if (comando === 'buscar') {
    const segmento = s('segmento');
    if (!segmento || !segmentoPorId(segmento)) throw new Error(`--segmento obrigatório: ${SEGMENTOS.map((x) => x.id).join(', ')}`);
    const busca = await ctx.central.criarBusca({
      uf: s('uf') ?? 'DF', cidade: s('cidade') ?? 'Brasilia', segmento,
      bairros: s('bairros')?.split(',').map((b) => b.trim()).filter(Boolean) ?? [],
      portes: (s('portes')?.split(',').map((p) => p.trim().toUpperCase()) ?? []) as never,
      quantidade_desejada: Number(s('quantidade') ?? 100),
    });
    log(`busca ${busca.id} criada; o worker começa em até 20 s (acompanhe no painel)`);
    await ctx.sql.end();
    return;
  }

  if (comando === 'reprocessar') {
    const buscaId = s('busca');
    if (!buscaId) throw new Error('--busca <id> obrigatório');
    const r = await fetch(`${ctx.config.centralUrl}/v1/buscas/${buscaId}/reprocessar`, {
      method: 'POST', headers: { authorization: `Bearer ${ctx.config.centralApiKey}` } });
    log(r.ok ? `busca ${buscaId} marcada para reprocessar; o worker começa em até 20 s` : `Central respondeu HTTP ${r.status}: ${await r.text()}`);
    await ctx.sql.end();
    return;
  }

  if (comando === 'worker') {
    const b = await boss(ctx.config.databaseUrl);
    // Busca cancelada no painel: as empresas que ainda estão na fila são puladas (status consultado no máx. a cada 15 s)
    const statusBusca = new Map<string, { status: string; em: number }>();
    const cancelada = async (buscaId: string | null) => {
      if (!buscaId) return false;
      const c = statusBusca.get(buscaId);
      if (c && Date.now() - c.em < 15_000) return c.status === 'cancelada';
      try {
        const { status } = await ctx.central.obterBusca(buscaId);
        statusBusca.set(buscaId, { status, em: Date.now() });
        return status === 'cancelada';
      } catch { return false; }
    };
    await b.work<{ busca_id: string }>(FILA_PLANEJAR, async ([job]) => {
      if (await cancelada(job!.data.busca_id)) return log(`busca ${job!.data.busca_id} cancelada antes de começar`);
      const jobs = await planejarBusca(ctx, job!.data.busca_id);
      for (const j of jobs) {
        await b.send(FILA_VERIFICAR, j, { retryLimit: 5, retryBackoff: true, retryDelay: 30, singletonKey: `${j.busca_id}:${j.cnpj}` });
      }
    });
    const verificar = async ([job]: PgBoss.JobWithMetadata<JobVerificar>[]) => {
      const j = job!;
      if (await cancelada(j.data.busca_id)) return; // cancelada no painel: pula sem gastar consultas
      try {
        await verificarEmpresa(ctx, j.data);
        await registrarProgresso(ctx, j.data.busca_id, true);
      } catch (e) {
        // Última tentativa: conta como falha para a busca poder terminar
        if (j.retryCount >= j.retryLimit) await registrarProgresso(ctx, j.data.busca_id, false);
        throw e;
      }
    };
    for (let i = 0; i < ctx.config.concorrencia; i++) {
      await b.work<JobVerificar>(FILA_VERIFICAR, { batchSize: 1, includeMetadata: true }, verificar);
    }
    // Busca nova ou pedido de reprocessamento feitos pelo painel: o worker verifica a cada 20 s
    let ocupado = false;
    const verificarPendentes = async () => {
      if (ocupado) return;
      ocupado = true;
      try {
        for (const busca of await ctx.central.listarBuscas(['planejada', 'reprocessar'])) {
          if (busca.status === 'planejada') {
            await b.send(FILA_PLANEJAR, { busca_id: busca.id }, { retryLimit: 3, retryBackoff: true, singletonKey: `planejar:${busca.id}` });
            await ctx.central.atualizarBusca(busca.id, { status: 'executando' });
          } else {
            const rodada = Date.now();
            for (const j of await prepararReprocesso(ctx, busca.id)) {
              await b.send(FILA_VERIFICAR, j, { retryLimit: 5, retryBackoff: true, retryDelay: 30, singletonKey: `${j.busca_id}:${j.cnpj}:${rodada}` });
            }
          }
        }
      } catch (e) {
        log(`aguardando a Central (${(e as Error).message})`);
      } finally { ocupado = false; }
    };
    const sinalDeVida = async () => {
      try { await ctx.central.reportarStatus('motor-prospecting', await metricasMotor(ctx)); } catch { /* Central ainda subindo */ }
    };
    setInterval(verificarPendentes, 20_000);
    setInterval(sinalDeVida, 30_000);
    setTimeout(() => { void verificarPendentes(); void sinalDeVida(); }, 3_000);

    await b.schedule(FILA_CLAUDE, '*/15 * * * *');
    await b.work(FILA_CLAUDE, async () => {
      const n = await consumirFilaClaude(ctx);
      if (n) log(`fila do Claude: ${n} empresas reprocessadas`);
    });
    log(`worker no ar (concorrência ${ctx.config.concorrencia}; busca web: ${ctx.provedores.map((p) => p.nome).join(' → ') || 'sem chaves'} → Claude)`);
    const parar = async () => { await b.stop({ graceful: true, timeout: 30_000 }); await ctx.sql.end(); process.exit(0); };
    process.on('SIGINT', parar);
    process.on('SIGTERM', parar);
    return;
  }

  if (comando === 'processar') {
    const cnpj = s('cnpj');
    if (!cnpj) throw new Error('--cnpj obrigatório');
    const [e] = await ctx.sql`select * , to_char(data_inicio, 'YYYY-MM-DD') as data_inicio from receita.estabelecimento where cnpj = ${cnpj}`;
    if (!e) throw new Error('CNPJ não está em receita.estabelecimento');
    const seg = segmentoPorCnae(e.cnae_principal as string)!;
    if (a.enviar) {
      console.log(await verificarEmpresa(ctx, { busca_id: null, cnpj, uf: e.uf as string, segmento: seg.id }));
    } else {
      const saida = await processarEstabelecimento(
        { sql: ctx.sql, rede: ctx.rede, provedores: ctx.provedores, config: ctx.config,
          catalogoOsm: await carregarCatalogo(ctx.sql, e.uf as string, seg.id) },
        e as never, { busca_id: null });
      console.log(JSON.stringify(saida, null, 2));
    }
    await ctx.sql.end();
    return;
  }

  if (comando === 'status') {
    const [r] = await ctx.sql`select count(*)::int as estabelecimentos, max(referencia) as referencia from receita.estabelecimento`;
    const fila = await ctx.sql`select status, count(*)::int as n from motor.fila_busca_web group by status`;
    const uso = await ctx.sql`select * from motor.uso_busca_web where mes = to_char(now(), 'YYYY-MM')`;
    const buscas = await ctx.sql`select * from motor.busca_progresso order by atualizado_em desc limit 5`;
    console.log(JSON.stringify({ base_receita: r, fila_claude: fila, cota_busca_web_mes: uso, buscas }, null, 2));
    await ctx.sql.end();
    return;
  }

  console.log('comandos: carregar-receita | buscar | reprocessar | worker | processar | status');
  await ctx.sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
