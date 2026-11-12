/**
 * Testes de integração contra um Postgres real com o schema de supabase/migrations.
 * Rode com TEST_DATABASE_URL apontando para um banco DESCARTÁVEL (as tabelas são truncadas).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarApp } from '../src/app.ts';
import { conectar, type Sql } from '../src/db.ts';

const URL = process.env.TEST_DATABASE_URL;
const SEGREDO = 'a'.repeat(40);
const AUTH = { authorization: `Bearer ${SEGREDO}` };
const AGORA = new Date().toISOString();

const verificacoesSemSite = {
  V1: { status: 'nao_executado' }, V2: { status: 'nada_encontrado' }, V3: { status: 'nao_aplicavel' },
  V4: { status: 'nada_encontrado' }, V5: { status: 'nao_executado' },
  V6: { status: 'executado', redes: ['instagram'] },
};

function candidata(extra: Record<string, unknown> = {}) {
  return {
    nome_fantasia: 'Clínica Sorriso Feliz',
    razao_social: 'Sorriso Feliz Odontologia LTDA',
    segmento: 'clinica_odontologica',
    situacao_receita: 'ATIVA',
    endereco: { uf: 'DF', cidade: 'Brasília', bairro: 'Asa Norte', cep: '70750-000', lat: -15.7601, lng: -47.8802 },
    identificadores: [{ fonte: 'osm', valor: 'node/123' }],
    contatos: [
      { tipo: 'telefone', valor: '(61) 3322-1100', publico_comercial: true, evidencia_ref: 'osm1' },
      { tipo: 'instagram', valor: 'https://instagram.com/sorrisofeliz', publico_comercial: true, evidencia_ref: 'osm1' },
    ],
    verificacoes: verificacoesSemSite,
    verificado_em: AGORA,
    evidencias: [
      { ref: 'osm1', fonte: 'osm', url: 'https://www.openstreetmap.org/node/123', coletado_em: AGORA, payload: {} },
      { ref: 'rf1', fonte: 'receita', url: null, coletado_em: AGORA, payload: { arquivo: 'Estabelecimentos0' } },
    ],
    ...extra,
  };
}

describe.skipIf(!URL)('Central de Oportunidades (integração)', () => {
  let sql: Sql;
  let app: ReturnType<typeof criarApp>;

  const ingest = (candidatas: unknown[], busca_id?: string) =>
    app.inject({ method: 'POST', url: '/v1/ingest/candidatas', headers: AUTH,
                 payload: { motor: 'prospecting@0.1.0', busca_id, candidatas } });

  beforeAll(async () => {
    sql = conectar(URL!);
    app = criarApp(sql, new Map([[SEGREDO, 'teste']]), { logger: false, painelSenha: 'senha-do-painel' });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await sql.end(); });
  beforeEach(async () => {
    await sql`truncate empresa, evidencia, busca, opt_out, segmento_prioritario, motor_status cascade`;
  });

  it('exige chave de API', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/empresas' });
    expect(r.statusCode).toBe(401);
  });

  it('rejeita contrato com contato sem evidência', async () => {
    const c = candidata({ contatos: [{ tipo: 'telefone', valor: '61 3322-1100', publico_comercial: true, evidencia_ref: 'xx' }] });
    const r = await ingest([c]);
    expect(r.statusCode).toBe(400);
  });

  it('cria empresa SOMENTE_REDES com oportunidade A e score explicado', async () => {
    await sql`insert into segmento_prioritario values ('clinica_odontologica', 8)`;
    const r = await ingest([candidata()]);
    expect(r.statusCode).toBe(200);
    const [res] = r.json().resultados;
    expect(res.acao).toBe('criada');
    expect(res.classificacao).toBe('SOMENTE_REDES');
    // 30 presença + 10 Receita ATIVA + 5 OSM + 10 telefone + 8 segmento
    expect(res.lead_score).toBe(63);

    const [op] = await sql`select tipo, prioridade, status, score_detalhe from oportunidade`;
    expect(op).toMatchObject({ tipo: 'A', prioridade: 'media', status: 'nova' });
    expect((op!.score_detalhe as { criterio: string }[]).map((l) => l.criterio))
      .toEqual(['presenca_digital', 'empresa_ativa', 'contato', 'tracao', 'segmento']);
  });

  it('reenvio na mesma busca é idempotente', async () => {
    const [b] = await sql`insert into busca (filtros) values ('{}') returning id`;
    await ingest([candidata()], b!.id);
    const r2 = await ingest([candidata()], b!.id);
    expect(r2.json().resultados[0].avisos).toContain('já ingerida nesta busca');
    const [{ n }] = await sql`select count(*)::int as n from empresa` as unknown as [{ n: number }];
    expect(n).toBe(1);
    const [{ e }] = await sql`select count(*)::int as e from evidencia` as unknown as [{ e: number }];
    expect(e).toBe(2);
  });

  it('mescla pelo telefone no mesmo local e só preenche lacunas', async () => {
    await ingest([candidata({ razao_social: null })]);
    const outra = candidata({
      nome_fantasia: 'Sorriso Feliz Odonto',
      cnpj: '11.222.333/0001-81',
      razao_social: 'Razão Nova',
      identificadores: [{ fonte: 'fsq_os', valor: 'fsq-9' }],
      contatos: [{ tipo: 'telefone', valor: '+55 61 3322-1100', publico_comercial: true, evidencia_ref: 'osm1' }],
    });
    const r = await ingest([outra]);
    expect(r.json().resultados[0].acao).toBe('mesclada');
    const [emp] = await sql`select nome_fantasia, cnpj, razao_social from empresa`;
    expect(emp).toEqual({ nome_fantasia: 'Clínica Sorriso Feliz', cnpj: '11222333000181', razao_social: 'Razão Nova' });
    const ids = await sql`select fonte from identificador_externo order by fonte`;
    expect(ids.map((i) => i.fonte)).toEqual(['fsq_os', 'osm']);
  });

  it('nome parecido no mesmo CEP vai para revisão, sem merge automático', async () => {
    await ingest([candidata()]);
    const r = await ingest([candidata({
      nome_fantasia: 'Clinica Sorriso Feliz ME',
      identificadores: [{ fonte: 'osm', valor: 'node/999' }],
      contatos: [],
      endereco: { uf: 'DF', cidade: 'Brasília', bairro: 'Asa Norte', cep: '70750000' },
    })]);
    expect(r.json().resultados[0].acao).toBe('revisao_merge');
    const [{ n }] = await sql`select count(*)::int as n from revisao_merge` as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it('CNPJ inválido é ignorado com aviso', async () => {
    const r = await ingest([candidata({ cnpj: '11.222.333/0001-82' })]);
    const [res] = r.json().resultados;
    expect(res.acao).toBe('criada');
    expect(res.avisos.join()).toMatch(/CNPJ .* inválido/);
  });

  it('verificação incompleta fica PENDENTE e não gera oportunidade', async () => {
    const r = await ingest([candidata({ verificacoes: { ...verificacoesSemSite, V4: { status: 'erro', detalhe: 'timeout' } } })]);
    expect(r.json().resultados[0].classificacao).toBe('PENDENTE');
    const ops = await sql`select 1 from oportunidade`;
    expect(ops.length).toBe(0);
  });

  it('opt-out descarta oportunidade aberta e bloqueia nova ingestão', async () => {
    await ingest([candidata()]);
    const o = await app.inject({ method: 'POST', url: '/v1/opt-out', headers: AUTH,
                                 payload: { chave: 'telefone', valor: '61 3322-1100', motivo: 'pediu no WhatsApp' } });
    expect(o.statusCode).toBe(201);
    expect(o.json().empresas_afetadas).toHaveLength(1);
    const [op] = await sql`select status from oportunidade`;
    expect(op!.status).toBe('descartada');

    await sql`delete from empresa`;
    const r = await ingest([candidata()]);
    expect(r.json().resultados[0].acao).toBe('bloqueada_opt_out');
    const [{ n }] = await sql`select count(*)::int as n from empresa` as unknown as [{ n: number }];
    expect(n).toBe(0);
  });

  it('ficha lista fontes e informações não encontradas; verificação manual sobe o score', async () => {
    const r = await ingest([candidata()]);
    const id = r.json().resultados[0].empresa_id as string;

    const f = (await app.inject({ method: 'GET', url: `/v1/empresas/${id}`, headers: AUTH })).json();
    expect(f.validacao.fontes.sort()).toEqual(['osm', 'receita']);
    expect(f.validacao.nao_encontrado).toEqual(expect.arrayContaining(['cnpj', 'contato.whatsapp', 'contato.email']));
    expect(f.empresa.geo).toBeUndefined();

    const m = await app.inject({ method: 'POST', url: `/v1/empresas/${id}/evidencias-manuais`, headers: AUTH,
                                 payload: { tipo: 'avaliacoes', quantidade: 84, nota: 4.8, url: 'https://maps.app.goo.gl/x' } });
    expect(m.statusCode).toBe(201);
    expect(m.json().lead_score).toBe(55 + 15);

    const site = await app.inject({ method: 'POST', url: `/v1/empresas/${id}/evidencias-manuais`, headers: AUTH,
                                    payload: { tipo: 'site_encontrado', url: 'https://sorrisofeliz.com.br' } });
    expect(site.json().classificacao).toBe('SITE_EXISTENTE');

    const lista = (await app.inject({ method: 'GET', url: '/v1/empresas?uf=DF&classificacao=SITE_EXISTENTE', headers: AUTH })).json();
    expect(lista.total).toBe(1);
  });

  // ------------------------------------------------------------------ painel
  it('painel: serve a página, exige senha e usa cookie de sessão', async () => {
    const pagina = await app.inject({ method: 'GET', url: '/' });
    expect(pagina.statusCode).toBe(200);
    expect(pagina.headers['content-security-policy']).toContain("default-src 'self'");
    expect((await app.inject({ method: 'GET', url: '/painel/..%2Fsrc%2Fconfig.ts' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/painel/../src/config.ts' })).statusCode).not.toBe(200);

    expect((await app.inject({ method: 'POST', url: '/painel/login', payload: { senha: 'errada' } })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/painel/login', payload: { senha: 'senha-do-painel' } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect(String(login.headers['set-cookie'])).toContain('HttpOnly');

    // leitura com cookie funciona; escrita com cookie exige x-painel (CSRF)
    expect((await app.inject({ method: 'GET', url: '/v1/painel/resumo', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/buscas', headers: { cookie }, payload: { uf: 'DF', cidade: 'Brasília', segmento: 'academia' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/buscas', headers: { cookie, 'x-painel': '1' }, payload: { uf: 'DF', cidade: 'Brasília', segmento: 'academia' } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/v1/painel/resumo', headers: { cookie: 'pi_sessao=1.forjado' } })).statusCode).toBe(401);
  });

  it('painel: resumo, reprocessar busca, aprovar oportunidade e sinal de vida do motor', async () => {
    const [b] = await sql`insert into busca (filtros, status) values ('{"segmento":"clinica_odontologica"}', 'concluida') returning id`;
    const ing = await ingest([candidata()], b!.id);
    const empresaId = ing.json().resultados[0].empresa_id;

    const resumo = (await app.inject({ method: 'GET', url: '/v1/painel/resumo', headers: AUTH })).json();
    expect(resumo.totais).toMatchObject({ empresas: 1, oportunidades: 1, aguardando_revisao: 1 });
    expect(resumo.classificacoes).toEqual([{ classificacao: 'SOMENTE_REDES', total: 1 }]);

    const rep = await app.inject({ method: 'POST', url: `/v1/buscas/${b!.id}/reprocessar`, headers: AUTH });
    expect(rep.json().status).toBe('reprocessar');
    expect((await app.inject({ method: 'POST', url: `/v1/buscas/${b!.id}/reprocessar`, headers: AUTH })).statusCode).toBe(409);
    const pendentes = (await app.inject({ method: 'GET', url: '/v1/buscas?status=planejada,reprocessar', headers: AUTH })).json();
    expect(pendentes.map((x: { id: string }) => x.id)).toEqual([b!.id]);

    const lista = (await app.inject({ method: 'GET', url: `/v1/empresas?busca=${b!.id}&q=sorriso`, headers: AUTH })).json();
    expect(lista.total).toBe(1);
    const opId = lista.itens[0].oportunidade_id;
    const ap = await app.inject({ method: 'PATCH', url: `/v1/oportunidades/${opId}`, headers: AUTH, payload: { status: 'aprovada_para_contato', observacao: 'ok para abordar' } });
    expect(ap.json().status).toBe('aprovada_para_contato');
    const ficha = (await app.inject({ method: 'GET', url: `/v1/empresas/${empresaId}`, headers: AUTH })).json();
    expect(ficha.oportunidades[0].interacoes[0].resumo).toBe('ok para abordar');

    await app.inject({ method: 'PUT', url: '/v1/motores/motor-prospecting', headers: AUTH, payload: { versao: 'prospecting@0.1.0', busca_web: [] } });
    const r2 = (await app.inject({ method: 'GET', url: '/v1/painel/resumo', headers: AUTH })).json();
    expect(r2.motores[0]).toMatchObject({ nome: 'motor-prospecting', dados: { versao: 'prospecting@0.1.0' } });
    expect(r2.motores[0].segundos_atras).toBeLessThan(5);
  });
});
