import { parse } from 'csv-parse';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import unzipper from 'unzipper';
import { normalizarNome } from '@ionext/dominio';
import type { Sql } from '../db.ts';
import {
  COLUNAS_EMPRESA, COLUNAS_ESTABELECIMENTO, COLUNAS_SIMPLES, PORTE,
  converterEstabelecimento, mapear, type EstabelecimentoReceita,
} from './layout.ts';

export interface OpcoesCarga {
  diretorio: string;   // pasta com os .zip baixados da Receita
  referencia: string;  // mês da base, ex.: 2026-10
  uf: string;
  municipio: string;   // nome, ex.: BRASILIA (resolvido pelo Municipios.zip)
  cnaes: string[];
  log?: (msg: string) => void;
}

export interface ResultadoCarga {
  municipio_codigo: string;
  linhas_lidas: number;
  carregadas: number;
  removidas: number;
  cnaes: Record<string, string>;
}

/** Lê cada linha do(s) CSV(s) dentro de um .zip da Receita, em streaming. */
async function* linhasDoZip(caminho: string): AsyncGenerator<string[]> {
  const zip = await unzipper.Open.file(caminho);
  for (const entrada of zip.files) {
    if (entrada.type !== 'File') continue;
    const parser = entrada.stream().pipe(parse({
      delimiter: ';', quote: '"', encoding: 'latin1',
      relax_quotes: true, relax_column_count: true, skip_empty_lines: true,
    }));
    for await (const registro of parser) yield registro as string[];
  }
}

async function arquivos(diretorio: string, prefixo: string): Promise<string[]> {
  const todos = await readdir(diretorio);
  const re = new RegExp(`^${prefixo}\\d*\\.zip$`, 'i');
  const lista = todos.filter((f) => re.test(f)).sort().map((f) => join(diretorio, f));
  if (lista.length === 0) throw new Error(`nenhum arquivo ${prefixo}*.zip em ${diretorio}`);
  return lista;
}

async function tabelaCodigos(diretorio: string, prefixo: string): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const f of await arquivos(diretorio, prefixo)) {
    for await (const [codigo, descricao] of linhasDoZip(f)) {
      if (codigo) m.set(codigo.trim(), (descricao ?? '').trim());
    }
  }
  return m;
}

export async function carregarReceita(sql: Sql, o: OpcoesCarga): Promise<ResultadoCarga> {
  const log = o.log ?? (() => {});
  const uf = o.uf.toUpperCase();

  // 1. Município pelo nome, a partir da tabela oficial (sem código fixo no programa)
  const municipios = await tabelaCodigos(o.diretorio, 'Municipios');
  const alvo = normalizarNome(o.municipio);
  const achados = [...municipios].filter(([, nome]) => normalizarNome(nome) === alvo);
  if (achados.length !== 1) throw new Error(`município "${o.municipio}": ${achados.length} correspondências em Municipios.zip`);
  const [municipioCodigo, municipioNome] = achados[0]!;
  log(`município ${municipioNome} = código ${municipioCodigo}`);

  // 2. Confere os CNAEs-alvo na tabela oficial
  const tabelaCnaes = await tabelaCodigos(o.diretorio, 'Cnaes');
  const faltando = o.cnaes.filter((c) => !tabelaCnaes.has(c));
  if (faltando.length) throw new Error(`CNAEs inexistentes na tabela da Receita: ${faltando.join(', ')}`);
  const cnaes = Object.fromEntries(o.cnaes.map((c) => [c, tabelaCnaes.get(c)!]));
  for (const [c, d] of Object.entries(cnaes)) log(`CNAE ${c}: ${d}`);

  const [carga] = await sql<{ id: string }[]>`
    insert into receita.carga (referencia, filtros) values (${o.referencia}, ${sql.json({ ...o, log: undefined } as never)}) returning id`;

  try {
    // 3. Estabelecimentos ativos do município nos CNAEs-alvo
    const setCnaes = new Set(o.cnaes);
    const estab = new Map<string, EstabelecimentoReceita>();
    let lidas = 0;
    for (const f of await arquivos(o.diretorio, 'Estabelecimentos')) {
      log(`lendo ${f}`);
      for await (const valores of linhasDoZip(f)) {
        lidas++;
        // Filtro barato antes de converter: UF (19), município (20), situação (5), CNAE (11)
        if (valores[19] !== uf || valores[20] !== municipioCodigo || valores[5] !== '02' || !setCnaes.has(valores[11] ?? '')) continue;
        const l = mapear(COLUNAS_ESTABELECIMENTO, valores);
        if (!l) continue;
        const e = converterEstabelecimento(l);
        estab.set(e.cnpj, e);
      }
    }
    log(`${estab.size} estabelecimentos selecionados de ${lidas} linhas`);

    // 4. Razão social e porte (Empresas) e Simples/MEI, só para os CNPJs básicos selecionados
    const basicos = new Set([...estab.values()].map((e) => e.cnpj_basico));
    const empresas = new Map<string, { razao: string; porte: string | null }>();
    for (const f of await arquivos(o.diretorio, 'Empresas')) {
      for await (const valores of linhasDoZip(f)) {
        if (!basicos.has(valores[0] ?? '')) continue;
        const l = mapear(COLUNAS_EMPRESA, valores);
        if (l) empresas.set(l.cnpj_basico, { razao: l.razao_social, porte: PORTE[l.porte_empresa as keyof typeof PORTE] ?? null });
      }
    }
    const simples = new Map<string, { simples: boolean; mei: boolean }>();
    for (const f of await arquivos(o.diretorio, 'Simples')) {
      for await (const valores of linhasDoZip(f)) {
        if (!basicos.has(valores[0] ?? '')) continue;
        const l = mapear(COLUNAS_SIMPLES, valores);
        if (l) simples.set(l.cnpj_basico, { simples: l.opcao_simples === 'S', mei: l.opcao_mei === 'S' });
      }
    }

    // 5. Upsert em lotes
    const linhas = [...estab.values()].map((e) => {
      const emp = empresas.get(e.cnpj_basico);
      const s = simples.get(e.cnpj_basico);
      return {
        cnpj: e.cnpj, cnpj_basico: e.cnpj_basico, matriz: e.matriz, nome_fantasia: e.nome_fantasia,
        razao_social: emp?.razao ?? null, situacao: e.situacao, data_inicio: e.data_inicio,
        cnae_principal: e.cnae_principal, cnaes_secundarios: e.cnaes_secundarios, logradouro: e.logradouro,
        bairro: e.bairro, bairro_normalizado: e.bairro_normalizado, cep: e.cep, uf: e.uf,
        municipio_codigo: e.municipio_codigo, municipio_nome: municipioNome, telefones: e.telefones,
        email: e.email, porte: emp?.porte ?? null, simples: s?.simples ?? null, mei: s?.mei ?? null,
        referencia: o.referencia,
      };
    });
    for (let i = 0; i < linhas.length; i += 500) {
      const lote = linhas.slice(i, i + 500);
      await sql`
        insert into receita.estabelecimento ${sql(lote)}
        on conflict (cnpj) do update set
          nome_fantasia = excluded.nome_fantasia, razao_social = excluded.razao_social, situacao = excluded.situacao,
          data_inicio = excluded.data_inicio, cnae_principal = excluded.cnae_principal,
          cnaes_secundarios = excluded.cnaes_secundarios, logradouro = excluded.logradouro, bairro = excluded.bairro,
          bairro_normalizado = excluded.bairro_normalizado, cep = excluded.cep, telefones = excluded.telefones,
          email = excluded.email, porte = excluded.porte, simples = excluded.simples, mei = excluded.mei,
          referencia = excluded.referencia, carregado_em = now()`;
    }

    // 6. Quem saiu da base (baixada, mudou de CNAE ou de município) não fica como ativo
    const removidas = await sql`
      delete from receita.estabelecimento
       where uf = ${uf} and municipio_codigo = ${municipioCodigo}
         and cnae_principal = any(${o.cnaes}::text[]) and referencia <> ${o.referencia}`;

    await sql`update receita.carga set linhas_lidas = ${lidas}, carregadas = ${linhas.length}, concluida_em = now()
              where id = ${carga!.id}`;
    log(`carga concluída: ${linhas.length} upserts, ${removidas.count} removidas`);
    return { municipio_codigo: municipioCodigo, linhas_lidas: lidas, carregadas: linhas.length, removidas: removidas.count, cnaes };
  } catch (err) {
    await sql`update receita.carga set erro = ${(err as Error).message} where id = ${carga!.id}`;
    throw err;
  }
}
