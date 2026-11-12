/**
 * Integração do Motor 01 contra Postgres real (schemas public, receita, motor).
 * TEST_DATABASE_URL deve apontar para um banco DESCARTÁVEL.
 */
import AdmZip from 'adm-zip';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarApp } from '../../central/src/app.ts';
import { conectar, type Sql } from '../src/db.ts';
import { ClienteCentral } from '../src/pipeline/central.ts';
import { consumirFilaClaude, planejarBusca, verificarEmpresa, type Contexto } from '../src/pipeline/orquestracao.ts';
import { processarEstabelecimento, type Estabelecimento } from '../src/pipeline/processar.ts';
import { carregarReceita } from '../src/receita/etl.ts';
import type { ProvedorBusca } from '../src/verificadores/buscaWeb.ts';
import { htmlSite, redeFalsa } from './fakes.ts';

const URL = process.env.TEST_DATABASE_URL;
const SEGREDO = 'b'.repeat(40);

// ---------------------------------------------------------------- fixtures da Receita (latin1, ";", aspas)
function csv(linhas: string[][]): Buffer {
  return Buffer.from(linhas.map((l) => l.map((c) => `"${c}"`).join(';')).join('\r\n') + '\r\n', 'latin1');
}
function zip(dir: string, nome: string, linhas: string[][]) {
  const z = new AdmZip();
  z.addFile(nome.replace('.zip', '.CSV'), csv(linhas));
  z.writeZip(join(dir, nome));
}
function estab(o: Partial<Record<string, string>>): string[] {
  const c = {
    basico: '11222333', ordem: '0001', dv: '81', mf: '1', fantasia: 'CLÍNICA SORRISO FELIZ', sit: '02', dsit: '20150310',
    mot: '00', cidext: '', pais: '', inicio: '20150310', cnae: '8630504', sec: '8630502,8630503', tlog: 'QUADRA',
    log: 'SCLN 210 BLOCO A', num: 'S/N', comp: 'SALA 101', bairro: 'ASA NORTE', cep: '70862510', uf: 'DF', mun: '9701',
    ddd1: '61', tel1: '33221100', ddd2: '', tel2: '', dddf: '', fax: '', email: 'SORRISOFELIZ@GMAIL.COM', se: '', dse: '', ...o,
  };
  return [c.basico, c.ordem, c.dv, c.mf, c.fantasia, c.sit, c.dsit, c.mot, c.cidext, c.pais, c.inicio, c.cnae, c.sec,
    c.tlog, c.log, c.num, c.comp, c.bairro, c.cep, c.uf, c.mun, c.ddd1, c.tel1, c.ddd2, c.tel2, c.dddf, c.fax, c.email, c.se, c.dse];
}

function montarDiretorioReceita(): string {
  const dir = mkdtempSync(join(tmpdir(), 'receita-'));
  zip(dir, 'Municipios.zip', [['9701', 'BRASILIA'], ['7107', 'SAO PAULO']]);
  zip(dir, 'Cnaes.zip', [['8630504', 'Atividade odontológica'], ['9313100', 'Atividades de condicionamento físico']]);
  zip(dir, 'Estabelecimentos0.zip', [
    estab({}),                                                                    // alvo
    estab({ basico: '22333444', ordem: '0001', dv: '00', sit: '08', fantasia: 'BAIXADA' }),  // baixada
    estab({ basico: '33444555', cnae: '4711302', fantasia: 'MERCADO' }),           // fora do segmento
    estab({ basico: '44555666', uf: 'SP', mun: '7107', fantasia: 'EM SP' }),       // outra UF
  ]);
  zip(dir, 'Estabelecimentos1.zip', [
    estab({ basico: '55666777', ordem: '0001', dv: '01', fantasia: 'ODONTO MEI', email: 'contato@odontomei.com.br', bairro: 'TAGUATINGA NORTE (TAGUATINGA)', tel1: '998887766' }),
  ]);
  zip(dir, 'Empresas0.zip', [
    ['11222333', 'SORRISO FELIZ ODONTOLOGIA LTDA', '2062', '49', '10000,00', '01', ''],
    ['55666777', 'JOAO DA SILVA 12345678900', '2135', '50', '1000,00', '01', ''],
  ]);
  zip(dir, 'Simples.zip', [
    ['11222333', 'S', '20150310', '00000000', 'N', '00000000', '00000000'],
    ['55666777', 'S', '20200101', '00000000', 'S', '20200101', '00000000'],
  ]);
  return dir;
}

const CNPJ_ALVO = '11222333000181';

describe.skipIf(!URL)('Motor 01 (integração)', () => {
  let sql: Sql;
  let app: ReturnType<typeof criarApp>;
  let central: ClienteCentral;
  const logs: string[] = [];

  beforeAll(async () => {
    sql = conectar(URL!);
    app = criarApp(sql, new Map([[SEGREDO, 'motor-teste']]), { logger: false });
    await app.ready();
    // Cliente da Central falando com a API real via inject (sem rede)
    const fetchInject = (async (url: string, init?: RequestInit) => {
      const r = await app.inject({ method: (init?.method ?? 'GET') as 'GET', url: url.replace('http://central', ''),
        headers: init?.headers as Record<string, string>, payload: init?.body as string | undefined });
      return new Response(r.body, { status: r.statusCode });
    }) as unknown as typeof fetch;
    central = new ClienteCentral('http://central', SEGREDO, fetchInject);
  });
  afterAll(async () => { await app.close(); await sql.end(); });
  beforeEach(async () => {
    logs.length = 0;
    await sql`truncate empresa, evidencia, busca, opt_out, segmento_prioritario cascade`;
    await sql`truncate receita.estabelecimento, receita.carga, motor.catalogo_osm, motor.catalogo_osm_atualizacao,
              motor.uso_busca_web, motor.fila_busca_web, motor.busca_progresso, motor.empresa_processada`;
  });

  const ctx = (rede: ReturnType<typeof redeFalsa>, provedores: ProvedorBusca[] = []): Contexto => ({
    sql, rede, central, provedores,
    config: { databaseUrl: '', centralUrl: '', centralApiKey: '', tavilyApiKey: null, tavilyLimiteMensal: 950, exaApiKey: null,
              exaLimiteMensal: 1300, exaTipo: 'auto', scoreMinimoBuscaWeb: 0, diasReprocessamento: 30, concorrencia: 1, userAgent: 't' },
    log: (m) => logs.push(m),
  });

  async function carregar() {
    return carregarReceita(sql, { diretorio: montarDiretorioReceita(), referencia: '2026-10', uf: 'DF', municipio: 'Brasília', cnaes: ['8630504'] });
  }
  async function estabelecimento(cnpj = CNPJ_ALVO): Promise<Estabelecimento> {
    const [e] = await sql<Estabelecimento[]>`select *, to_char(data_inicio, 'YYYY-MM-DD') as data_inicio from receita.estabelecimento where cnpj = ${cnpj}`;
    return e!;
  }
  const deps = (rede: ReturnType<typeof redeFalsa>, provedores: ProvedorBusca[] = [], catalogoOsm: never[] | null = []) =>
    ({ sql, rede, provedores, config: { scoreMinimoBuscaWeb: 0 }, catalogoOsm });

  // ------------------------------------------------------------------------------------------- ETL
  it('carrega só ativos do município nos CNAEs-alvo, decodifica latin1 e junta Empresas/Simples', async () => {
    const r = await carregar();
    expect(r.municipio_codigo).toBe('9701');
    expect(r.carregadas).toBe(2);
    const e = await estabelecimento();
    expect(e).toMatchObject({
      nome_fantasia: 'CLÍNICA SORRISO FELIZ', razao_social: 'SORRISO FELIZ ODONTOLOGIA LTDA', situacao: 'ATIVA',
      porte: 'ME', mei: false, telefones: ['+556133221100'], email: 'sorrisofeliz@gmail.com', data_inicio: '2015-03-10',
    });
    expect((await estabelecimento('55666777000101')).mei).toBe(true);
  });

  it('aborta se um CNAE-alvo não existe na tabela oficial', async () => {
    await expect(carregarReceita(sql, { diretorio: montarDiretorioReceita(), referencia: '2026-10', uf: 'DF', municipio: 'Brasilia', cnaes: ['9999999'] }))
      .rejects.toThrow(/CNAEs inexistentes/);
  });

  // ------------------------------------------------------------------------------------------- verificações
  it('SOMENTE_REDES: sem site em V2–V4, busca web acha Instagram compatível e ignora diretório', async () => {
    await carregar();
    const provedor: ProvedorBusca = { nome: 'fake', limiteMensal: 10, buscar: async () => [
      { url: 'https://www.instagram.com/clinicasorrisofeliz/', titulo: 'Clínica Sorriso Feliz (@clinicasorrisofeliz)', trecho: '' },
      { url: 'https://www.doctoralia.com.br/clinicas/sorriso-feliz', titulo: 'Sorriso Feliz - Doctoralia', trecho: '' },
      { url: 'https://www.instagram.com/outra_clinica/', titulo: 'Outra Clínica', trecho: '' },
    ] };
    const s = await processarEstabelecimento(deps(redeFalsa({}), [provedor]), await estabelecimento(), { busca_id: null });
    expect(s.buscaWeb).toBe('executada');
    expect(s.candidata.verificacoes!.V6).toEqual({ status: 'executado', redes: ['instagram'] });
    expect(s.candidata.contatos.find((c) => c.tipo === 'instagram')?.valor).toBe('https://www.instagram.com/clinicasorrisofeliz/');
    expect(s.candidata.verificacoes!.V3).toEqual({ status: 'nao_aplicavel' }); // gmail
    const r = await central.enviar([s.candidata], null);
    expect(r.resultados[0]).toMatchObject({ acao: 'criada', classificacao: 'SOMENTE_REDES' });
  });

  it('SITE_EXISTENTE: domínio candidato com o telefone da empresa na página', async () => {
    await carregar();
    const rede = redeFalsa({
      dns: { 'sorrisofeliz.com.br': ['1.2.3.4'] },
      paginas: { 'https://sorrisofeliz.com.br/': { corpo: htmlSite('Agende: (61) 3322-1100') } },
    });
    const s = await processarEstabelecimento(deps(rede), await estabelecimento(), { busca_id: null });
    expect(s.candidata.verificacoes!.V4).toEqual({ status: 'site_encontrado', url: 'https://sorrisofeliz.com.br/', acessivel: true });
    expect(s.buscaWeb).toBe('pulada'); // já tem site: não gasta cota
  });

  it('PENDENTE: domínio candidato só com o nome (pode ser de outra empresa)', async () => {
    await carregar();
    const rede = redeFalsa({
      dns: { 'sorrisofeliz.com.br': ['1.2.3.4'] },
      paginas: { 'https://sorrisofeliz.com.br/': { corpo: htmlSite('Bem-vindo à Clínica Sorriso Feliz de Curitiba') } },
    });
    const s = await processarEstabelecimento(deps(rede), await estabelecimento(), { busca_id: null });
    expect(s.candidata.verificacoes!.V4.status).toBe('inconclusivo');
    const r = await central.enviar([s.candidata], null);
    expect(r.resultados[0]!.classificacao).toBe('PENDENTE');
  });

  it('domínio de terceiro sem relação é ignorado', async () => {
    await carregar();
    const rede = redeFalsa({
      dns: { 'sorrisofeliz.com.br': ['1.2.3.4'] },
      paginas: { 'https://sorrisofeliz.com.br/': { corpo: htmlSite('Loja de roupas infantis') } },
    });
    const s = await processarEstabelecimento(deps(rede), await estabelecimento(), { busca_id: null });
    expect(s.candidata.verificacoes!.V4).toEqual({ status: 'nada_encontrado' });
  });

  it('PRESENCA_FRACA: domínio do e-mail declarado existe mas o site não responde; MEI não tem contato comercial', async () => {
    await carregar();
    const rede = redeFalsa({ dns: { 'odontomei.com.br': ['1.2.3.4'] } }); // DNS ok, HTTP recusa
    const s = await processarEstabelecimento(deps(rede), await estabelecimento('55666777000101'), { busca_id: null });
    expect(s.candidata.verificacoes!.V3).toEqual({ status: 'site_encontrado', url: 'https://odontomei.com.br', acessivel: false });
    expect(s.candidata.porte).toBe('MEI');
    expect(s.candidata.contatos.every((c) => c.publico_comercial === false)).toBe(true);
    const r = await central.enviar([s.candidata], null);
    expect(r.resultados[0]!.classificacao).toBe('PRESENCA_FRACA');
  });

  it('erro de DNS em verificação obrigatória → PENDENTE; catálogo OSM ausente → V2 erro', async () => {
    await carregar();
    const rede = redeFalsa({ dns: { 'sorrisofeliz.com.br': 'erro' } });
    const s = await processarEstabelecimento(deps(rede, [], null), await estabelecimento(), { busca_id: null });
    expect(s.candidata.verificacoes!.V2.status).toBe('erro');
    expect(s.candidata.verificacoes!.V4.status).toBe('erro');
  });

  it('casa com o OSM pelo telefone e usa o site da tag website', async () => {
    await carregar();
    const poi = { osm_id: 'node/42', nome: 'Odonto Sorriso', lat: -15.76, lng: -47.88,
                  tags: { name: 'Odonto Sorriso', phone: '+55 61 3322-1100', website: 'https://sorriso.odo.br', 'contact:instagram': 'sorrisofeliz' } };
    const rede = redeFalsa({ paginas: { 'https://sorriso.odo.br': { corpo: htmlSite('Clínica') } } });
    const s = await processarEstabelecimento(deps(rede, [], [poi] as never), await estabelecimento(), { busca_id: null });
    expect(s.candidata.verificacoes!.V2).toEqual({ status: 'site_encontrado', url: 'https://sorriso.odo.br', acessivel: true });
    expect(s.candidata.identificadores).toContainEqual({ fonte: 'osm', valor: 'node/42' });
    expect(s.candidata.endereco.lat).toBe(-15.76);
  });

  // ------------------------------------------------------------------------------------------- cota e fila do Claude
  it('respeita a cota gratuita e cai para a fila do Claude quando tudo esgota', async () => {
    await carregar();
    let chamadas = 0;
    const p: ProvedorBusca = { nome: 'tavily', limiteMensal: 1, buscar: async () => { chamadas++; return []; } };
    await processarEstabelecimento(deps(redeFalsa({}), [p]), await estabelecimento(), { busca_id: null });
    const s2 = await processarEstabelecimento(deps(redeFalsa({}), [p]), await estabelecimento('55666777000101'), { busca_id: null });
    expect(chamadas).toBe(1);
    expect(s2.buscaWeb).toBe('enfileirada_claude');
    const fila = await sql`select cnpj, consulta, contexto from motor.fila_busca_web`;
    expect(fila).toHaveLength(1);
    expect(fila[0]!.consulta).toContain('Odonto Mei');
    expect(s2.candidata.verificacoes!.V5).toEqual({ status: 'nao_executado' });
  });

  it('ponta a ponta: busca → planejamento → verificação → Central; resultado do Claude reprocessa', async () => {
    await carregar();
    const rede = redeFalsa({});
    const c = ctx(rede); // sem provedores → fila do Claude
    // Catálogo OSM: Overpass "fora do ar" na rede falsa → V2 erro; marcamos catálogo vazio já atualizado
    await sql`insert into motor.catalogo_osm_atualizacao (uf, segmento, total) values ('DF', 'clinica_odontologica', 0)`;

    const busca = await central.criarBusca({ uf: 'DF', cidade: 'Brasília', segmento: 'clinica_odontologica', bairros: ['Asa Norte'], quantidade_desejada: 10 } as never);
    const jobs = await planejarBusca(c, busca.id);
    expect(jobs.map((j) => j.cnpj)).toEqual([CNPJ_ALVO]); // filtro por bairro

    const r = await verificarEmpresa(c, jobs[0]!);
    expect(r).toMatchObject({ acao: 'criada', classificacao: 'SEM_SITE', busca_web: 'enfileirada_claude' });

    // O Claude (tarefa agendada) grava o que encontrou
    await sql`update motor.fila_busca_web set status = 'concluida', concluido_em = now(),
              resultado = ${sql.json({ urls: [{ url: 'https://www.instagram.com/sorrisofelizbsb/', observacao: 'Clínica Sorriso Feliz Asa Norte' }], pesquisado_em: new Date().toISOString() } as never)}`;
    expect(await consumirFilaClaude(c)).toBe(1);

    const [pres] = await sql`select classificacao, confiabilidade from presenca_digital`;
    expect(pres).toEqual({ classificacao: 'SOMENTE_REDES', confiabilidade: 'media' });
    const [{ n }] = await sql`select count(*)::int as n from empresa` as unknown as [{ n: number }];
    expect(n).toBe(1); // reprocessamento mesclou, não duplicou
    const [fila] = await sql`select processado_em from motor.fila_busca_web`;
    expect(fila!.processado_em).not.toBeNull();
  });
});
