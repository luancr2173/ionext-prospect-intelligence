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
  consumirFilaClaude, planejarBusca, registrarProgresso, verificarEmpresa, type Contexto, type JobVerificar,
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
    const b = await boss(ctx.config.databaseUrl);
    await b.send(FILA_PLANEJAR, { busca_id: busca.id }, { retryLimit: 3, retryBackoff: true });
    log(`busca ${busca.id} criada e enviada ao planejamento (o worker precisa estar rodando)`);
    await b.stop({ graceful: true });
    await ctx.sql.end();
    return;
  }

  if (comando === 'reprocessar') {
    const buscaId = s('busca');
    if (!buscaId) throw new Error('--busca <id> obrigatório');
    const linhas = await ctx.sql<{ cnpj: string; uf: string; cnae_principal: string }[]>`
      select e.cnpj, r.uf, r.cnae_principal from busca_resultado br
        join empresa e on e.id = br.empresa_id
        join receita.estabelecimento r on r.cnpj = e.cnpj
       where br.busca_id = ${buscaId}`;
    await ctx.sql`insert into motor.busca_progresso (busca_id, total) values (${buscaId}, ${linhas.length})
                  on conflict (busca_id) do update set total = excluded.total, processadas = 0, falhas = 0, atualizado_em = now()`;
    await ctx.central.atualizarBusca(buscaId, { status: 'executando', concluidas: 0 });
    const b = await boss(ctx.config.databaseUrl);
    const rodada = Date.now();
    for (const l of linhas) {
      const seg = segmentoPorCnae(l.cnae_principal);
      if (!seg) continue;
      await b.send(FILA_VERIFICAR, { busca_id: buscaId, cnpj: l.cnpj, uf: l.uf, segmento: seg.id },
        { retryLimit: 5, retryBackoff: true, retryDelay: 30, singletonKey: `${buscaId}:${l.cnpj}:${rodada}` });
    }
    log(`${linhas.length} empresas da busca ${buscaId} reenviadas para verificação (busca web usa o cache)`);
    await b.stop({ graceful: true });
    await ctx.sql.end();
    return;
  }

  if (comando === 'worker') {
    const b = await boss(ctx.config.databaseUrl);
    await b.work<{ busca_id: string }>(FILA_PLANEJAR, async ([job]) => {
      const jobs = await planejarBusca(ctx, job!.data.busca_id);
      for (const j of jobs) {
        await b.send(FILA_VERIFICAR, j, { retryLimit: 5, retryBackoff: true, retryDelay: 30, singletonKey: `${j.busca_id}:${j.cnpj}` });
      }
    });
    const verificar = async ([job]: PgBoss.JobWithMetadata<JobVerificar>[]) => {
      const j = job!;
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
