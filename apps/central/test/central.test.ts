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
    expect(f.neo.envios).toEqual([]);
    expect(f.neo).toHaveProperty('whatsapp');

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

  it('CRM: canal de contato (WhatsApp x fixo), funil por etapa e aprovação em lote', async () => {
    const celular = candidata({
      nome_fantasia: 'Clínica Celular', identificadores: [{ fonte: 'osm', valor: 'node/900' }],
      endereco: { uf: 'DF', cidade: 'Brasília', bairro: 'Asa Sul', cep: '70300-000', lat: -15.80, lng: -47.89 },
      contatos: [{ tipo: 'telefone', valor: '(61) 99811-2233', publico_comercial: true, evidencia_ref: 'osm1' }],
    });
    const antigo = candidata({
      nome_fantasia: 'Clínica Celular Antigo', identificadores: [{ fonte: 'osm', valor: 'node/901' }],
      endereco: { uf: 'DF', cidade: 'Brasília', bairro: 'Guará', cep: '71000-000', lat: -15.83, lng: -47.98 },
      contatos: [{ tipo: 'telefone', valor: '(61) 8123-4567', publico_comercial: true, evidencia_ref: 'osm1' }],
    });
    await ingest([candidata(), celular, antigo]);

    const todas = (await app.inject({ method: 'GET', url: '/v1/empresas', headers: AUTH })).json();
    expect(todas.canais).toEqual({ whatsapp: 2, fixo: 1 });
    const zap = (await app.inject({ method: 'GET', url: '/v1/empresas?canal=whatsapp', headers: AUTH })).json();
    expect(zap.total).toBe(2);
    expect(zap.itens.map((e: { telefone: string }) => e.telefone).sort()).toEqual(['+5561981234567', '+5561998112233']);
    expect(zap.canais).toEqual({ whatsapp: 2, fixo: 1 }); // abas continuam mostrando todos os canais
    const fixo = (await app.inject({ method: 'GET', url: '/v1/empresas?canal=fixo', headers: AUTH })).json();
    expect(fixo.itens.map((e: { nome_fantasia: string }) => e.nome_fantasia)).toEqual(['Clínica Sorriso Feliz']);

    const ids = zap.itens.map((e: { oportunidade_id: string }) => e.oportunidade_id);
    const lote = await app.inject({ method: 'POST', url: '/v1/oportunidades/status-em-lote', headers: AUTH, payload: { ids, status: 'aprovada_para_contato' } });
    expect(lote.json()).toEqual({ atualizadas: 2 });

    const funil = (await app.inject({ method: 'GET', url: '/v1/pipeline', headers: AUTH })).json();
    expect(funil.etapas.aprovada_para_contato.total).toBe(2);
    expect(funil.etapas.revisar.total).toBe(1);
    expect(funil.etapas.revisar.itens[0]).toMatchObject({ nome_fantasia: 'Clínica Sorriso Feliz', canal: 'fixo' });
    const soZap = (await app.inject({ method: 'GET', url: '/v1/pipeline?canal=whatsapp', headers: AUTH })).json();
    expect(soZap.etapas.revisar).toBeUndefined();

    // lote não mexe em quem já está no meio da conversa
    await sql`update oportunidade set status = 'respondeu' where id = ${ids[0]}`;
    const lote2 = await app.inject({ method: 'POST', url: '/v1/oportunidades/status-em-lote', headers: AUTH, payload: { ids, status: 'descartada' } });
    expect(lote2.json()).toEqual({ atualizadas: 1 });

    // tempo na etapa, histórico, "hoje" e conversão
    const [h1] = await sql`select count(*)::int as n from oportunidade_etapa where oportunidade_id = ${ids[0]} and para = 'respondeu'`;
    expect(h1!.n).toBe(1);
    await sql`update oportunidade set status = 'proposta', etapa_desde = now() - interval '12 days' where id = ${ids[1]}`;
    await sql`update oportunidade set etapa_desde = now() - interval '12 days' where id = ${ids[1]}`;
    const funil2 = (await app.inject({ method: 'GET', url: '/v1/pipeline', headers: AUTH })).json();
    expect(funil2.etapas.proposta.itens[0].dias_na_etapa).toBe(12);
    expect(funil2.prazos.proposta).toBe(10);
    const hoje = (await app.inject({ method: 'GET', url: '/v1/painel/hoje', headers: AUTH })).json();
    expect(hoje.itens.map((x: { motivo: string }) => x.motivo)).toEqual(['parada']);
    const resumo = (await app.inject({ method: 'GET', url: '/v1/painel/resumo', headers: AUTH })).json();
    expect(resumo.funil).toMatchObject({ abordadas: 2, responderam: 2, propostas: 1, ganhas: 0 });
    // mudar algo que não é o status não reinicia o relógio da etapa
    await sql`update oportunidade set lead_score = 55 where id = ${ids[1]}`;
    const [o] = await sql`select floor(extract(epoch from now() - etapa_desde) / 86400)::int as d from oportunidade where id = ${ids[1]}`;
    expect(o!.d).toBe(12);
  });

  it('CRM: caixa de respostas, "para hoje" por urgência e valor do negócio', async () => {
    const outra = candidata({
      nome_fantasia: 'Clínica Dois', identificadores: [{ fonte: 'osm', valor: 'node/902' }],
      endereco: { uf: 'DF', cidade: 'Brasília', bairro: 'Lago Sul', cep: '71600-000', lat: -15.84, lng: -47.87 },
      contatos: [{ tipo: 'telefone', valor: '(61) 99877-6655', publico_comercial: true, evidencia_ref: 'osm1' }],
    });
    const terceira = candidata({
      nome_fantasia: 'Clínica Três', identificadores: [{ fonte: 'osm', valor: 'node/903' }],
      endereco: { uf: 'DF', cidade: 'Brasília', bairro: 'Cruzeiro', cep: '70640-000', lat: -15.79, lng: -47.93 },
      contatos: [{ tipo: 'telefone', valor: '(61) 99666-5544', publico_comercial: true, evidencia_ref: 'osm1' }],
    });
    await ingest([candidata(), outra, terceira]);
    const ops = await sql`select o.id, e.nome_fantasia from oportunidade o join empresa e on e.id = o.empresa_id order by e.nome_fantasia`;
    const id = (nome: string) => ops.find((o) => o.nome_fantasia === nome)!.id as string;
    const [a, b, c] = [id('Clínica Dois'), id('Clínica Três'), id('Clínica Sorriso Feliz')];
    const mensagem = (op: string, minutos: number, texto: string) => sql`
      insert into interacao (oportunidade_id, canal, direcao, resumo, registrado_por, registrado_em)
      values (${op}, 'whatsapp', 'entrada', ${texto}, 'neo', now() - make_interval(mins => ${minutos}))`;
    const respostas = async () => (await app.inject({ method: 'GET', url: '/v1/painel/respostas', headers: AUTH })).json().itens;

    await sql`update oportunidade set status = 'respondeu' where id in (${a}, ${b})`;
    await mensagem(a, 30, 'Oi, quanto custa um site?');
    await mensagem(b, 90, 'Quem fala?');
    await mensagem(b, 80, 'Pode mandar o portfólio');
    let caixa = await respostas();
    expect(caixa.map((x: { nome_fantasia: string }) => x.nome_fantasia)).toEqual(['Clínica Três', 'Clínica Dois']); // quem espera mais vem antes
    expect(caixa[0]).toMatchObject({ ultima_mensagem: 'Pode mandar o portfólio', novas: 2, canal: 'whatsapp' });

    // "já vi" tira da caixa até chegar mensagem nova; anotação de uma pessoa também
    await app.inject({ method: 'POST', url: `/v1/oportunidades/${b}/respostas-vistas`, headers: AUTH });
    await app.inject({ method: 'PATCH', url: `/v1/oportunidades/${a}`, headers: AUTH, payload: { status: 'respondeu', observacao: 'Liguei e expliquei os planos' } });
    expect(await respostas()).toEqual([]);
    await mensagem(b, 0, 'Pode ser terça?');
    caixa = await respostas();
    expect(caixa).toHaveLength(1);
    expect(caixa[0]).toMatchObject({ id: b, novas: 1 });

    // valor e datas do negócio
    const ruim = await app.inject({ method: 'PATCH', url: `/v1/oportunidades/${a}/negocio`, headers: AUTH, payload: { proposta_valor: -5 } });
    expect(ruim.statusCode).toBe(400);
    const reuniao = new Date(Date.now() + 3 * 3600_000).toISOString();
    await app.inject({ method: 'PATCH', url: `/v1/oportunidades/${a}`, headers: AUTH, payload: { status: 'reuniao' } });
    await app.inject({ method: 'PATCH', url: `/v1/oportunidades/${a}/negocio`, headers: AUTH, payload: { reuniao_em: reuniao } });
    await app.inject({ method: 'PATCH', url: `/v1/oportunidades/${c}`, headers: AUTH, payload: { status: 'proposta' } });
    const neg = await app.inject({ method: 'PATCH', url: `/v1/oportunidades/${c}/negocio`, headers: AUTH,
      payload: { proposta_valor: 2500, proposta_solucao: 'Site institucional', previsao_fechamento: '2020-01-10' } });
    expect(neg.statusCode).toBe(200);
    expect(neg.json()).toMatchObject({ proposta_valor: 2500, proposta_solucao: 'Site institucional', previsao_fechamento: '2020-01-10' });
    await sql`update oportunidade set status = 'aprovada_para_contato' where id = ${b}`;
    await sql`update oportunidade set etapa_desde = now() - interval '9 days' where id = ${b}`;

    const hoje = (await app.inject({ method: 'GET', url: '/v1/painel/hoje', headers: AUTH })).json();
    expect(hoje.itens.map((x: { motivo: string }) => x.motivo)).toEqual(['reuniao', 'fechamento', 'parada']);
    expect(hoje.itens[2]).toMatchObject({ id: b, dias_atraso: 6 });

    const ficha = (await app.inject({ method: 'GET', url: `/v1/empresas/${(await sql`select empresa_id from oportunidade where id = ${c}`)[0]!.empresa_id}`, headers: AUTH })).json();
    expect(ficha.oportunidades[0]).toMatchObject({ proposta_valor: 2500, previsao_fechamento: '2020-01-10' });
    const funil = (await app.inject({ method: 'GET', url: '/v1/pipeline', headers: AUTH })).json();
    expect(funil.valores.proposta).toEqual({ valor: 2500, com_valor: 1 });
    await app.inject({ method: 'PATCH', url: `/v1/oportunidades/${c}`, headers: AUTH, payload: { status: 'ganha' } });
    const resumo = (await app.inject({ method: 'GET', url: '/v1/painel/resumo', headers: AUTH })).json();
    expect(resumo.valores).toEqual({ em_proposta: 0, ganho_mes: 2500 });
  });

  it('CRM: assumir a conversa e revisar opt-out duvidoso', async () => {
    const zap = candidata({
      nome_fantasia: 'Clínica Assumida', identificadores: [{ fonte: 'osm', valor: 'node/950' }],
      contatos: [{ tipo: 'telefone', valor: '(61) 99555-4433', publico_comercial: true, evidencia_ref: 'osm1' }],
    });
    await ingest([zap]);
    const [o] = await sql`select o.id from oportunidade o join empresa e on e.id = o.empresa_id where e.nome_fantasia = 'Clínica Assumida'`;
    const id = o!.id as string;
    const pausa = await app.inject({ method: 'POST', url: `/v1/oportunidades/${id}/neo`, headers: AUTH, payload: { pausado: true } });
    expect(pausa.statusCode).toBe(200);
    expect(pausa.json().neo_pausado_em).toBeTruthy();
    // assumir não conta como "já respondi": a mensagem continua na caixa de respostas
    await sql`update oportunidade set status = 'respondeu' where id = ${id}`;
    await sql`insert into interacao (oportunidade_id, canal, direcao, resumo, registrado_por, registrado_em)
              values (${id}, 'whatsapp', 'entrada', 'Quero falar com uma pessoa', 'neo', now() - interval '1 minute')`;
    const caixa = (await app.inject({ method: 'GET', url: '/v1/painel/respostas', headers: AUTH })).json();
    expect(caixa.itens.map((x: { id: string }) => x.id)).toEqual([id]);
    expect(caixa.itens[0].neo_pausado_em).toBeTruthy();
    const volta = await app.inject({ method: 'POST', url: `/v1/oportunidades/${id}/neo`, headers: AUTH, payload: { pausado: false } });
    expect(volta.json().neo_pausado_em).toBeNull();
    const [n] = await sql`select count(*)::int as n from interacao where oportunidade_id = ${id} and resumo like '%conversa%'`;
    expect(n!.n).toBe(2);

    // opt-out duvidoso: desfazer devolve para "Responderam" com a conversa assumida
    await sql`update oportunidade set status = 'descartada' where id = ${id}`;
    await sql`insert into opt_out (chave, valor, motivo, revisao, mensagem, oportunidade_id)
              values ('telefone', '+5561995554433', 'pediu pelo WhatsApp', 'pendente', 'agora não, talvez depois', ${id})`;
    const lista = (await app.inject({ method: 'GET', url: '/v1/painel/opt-out-revisar', headers: AUTH })).json();
    expect(lista.itens).toHaveLength(1);
    expect(lista.itens[0]).toMatchObject({ nome_fantasia: 'Clínica Assumida', mensagem: 'agora não, talvez depois' });
    const des = await app.inject({ method: 'POST', url: '/v1/opt-out/revisar', headers: AUTH,
      payload: { chave: 'telefone', valor: '+5561995554433', decisao: 'desfazer' } });
    expect(des.statusCode).toBe(200);
    const [depois] = await sql`select status, neo_pausado_em from oportunidade where id = ${id}`;
    expect(depois!.status).toBe('respondeu');
    expect(depois!.neo_pausado_em).toBeTruthy();
    const [sem] = await sql`select count(*)::int as n from opt_out where valor = '+5561995554433'`;
    expect(sem!.n).toBe(0);
    const de_novo = await app.inject({ method: 'POST', url: '/v1/opt-out/revisar', headers: AUTH,
      payload: { chave: 'telefone', valor: '+5561995554433', decisao: 'manter' } });
    expect(de_novo.statusCode).toBe(404);
  });

  it('CRM: motivo de perda, tarefas e exportação', async () => {
    const outra = candidata({
      nome_fantasia: '=Clínica Fórmula', identificadores: [{ fonte: 'osm', valor: 'node/960' }],
      endereco: { uf: 'DF', cidade: 'Brasília', bairro: 'Noroeste', cep: '70680-000', lat: -15.74, lng: -47.91 },
      contatos: [{ tipo: 'telefone', valor: '(61) 99444-3322', publico_comercial: true, evidencia_ref: 'osm1' },
                 { tipo: 'email', valor: 'contato@formula.com.br', publico_comercial: true, evidencia_ref: 'osm1' }],
    });
    const bloqueada = candidata({
      nome_fantasia: 'Clínica Bloqueada', identificadores: [{ fonte: 'osm', valor: 'node/961' }],
      endereco: { uf: 'DF', cidade: 'Brasília', bairro: 'Cruzeiro', cep: '70640-000', lat: -15.79, lng: -47.93 },
      contatos: [{ tipo: 'telefone', valor: '(61) 99333-2211', publico_comercial: true, evidencia_ref: 'osm1' }],
    });
    await ingest([outra, bloqueada]);
    const [o] = await sql`select o.id from oportunidade o join empresa e on e.id = o.empresa_id where e.nome_fantasia = '=Clínica Fórmula'`;
    const id = o!.id as string;
    const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/v1/oportunidades/${id}`, headers: AUTH, payload });

    // perda exige motivo; anotação numa perdida mantém o motivo; reabrir apaga
    expect((await patch({ status: 'perdida' })).statusCode).toBe(400);
    const perdeu = await patch({ status: 'perdida', motivo_perda: 'preco', motivo_perda_obs: 'achou caro' });
    expect(perdeu.json()).toMatchObject({ status: 'perdida', motivo_perda: 'preco', motivo_perda_obs: 'achou caro' });
    expect((await patch({ status: 'perdida', observacao: 'liguei de novo' })).json()).toMatchObject({ motivo_perda: 'preco', motivo_perda_obs: 'achou caro' });
    const resumo = (await app.inject({ method: 'GET', url: '/v1/painel/resumo', headers: AUTH })).json();
    expect(resumo.perdas).toEqual([{ motivo: 'preco', total: 1 }]);
    expect((await patch({ status: 'nova' })).json()).toMatchObject({ motivo_perda: null, motivo_perda_obs: null });

    // tarefas: vencida entra no "para hoje"; concluída sai
    const t = await app.inject({ method: 'POST', url: `/v1/oportunidades/${id}/tarefas`, headers: AUTH,
      payload: { titulo: 'Ligar para a recepção', vence_em: '2020-01-01' } });
    expect(t.statusCode).toBe(201);
    await app.inject({ method: 'POST', url: `/v1/oportunidades/${id}/tarefas`, headers: AUTH, payload: { titulo: 'Futura', vence_em: '2999-01-01' } });
    let hoje = (await app.inject({ method: 'GET', url: '/v1/painel/hoje', headers: AUTH })).json();
    const tarefas = hoje.itens.filter((x: { motivo: string }) => x.motivo === 'tarefa');
    expect(tarefas.map((x: { titulo: string }) => x.titulo)).toEqual(['Ligar para a recepção']);
    expect(tarefas[0].dias_atraso).toBeGreaterThan(1000);
    const ficha = (await app.inject({ method: 'GET', url: `/v1/empresas/${(await sql`select empresa_id from oportunidade where id = ${id}`)[0]!.empresa_id}`, headers: AUTH })).json();
    expect(ficha.oportunidades[0].tarefas.map((x: { titulo: string }) => x.titulo)).toEqual(['Ligar para a recepção', 'Futura']);
    await app.inject({ method: 'PATCH', url: `/v1/tarefas/${t.json().id}`, headers: AUTH, payload: { concluida: true } });
    hoje = (await app.inject({ method: 'GET', url: '/v1/painel/hoje', headers: AUTH })).json();
    expect(hoje.itens.filter((x: { motivo: string }) => x.motivo === 'tarefa')).toHaveLength(0);
    expect((await app.inject({ method: 'DELETE', url: `/v1/tarefas/${t.json().id}`, headers: AUTH })).statusCode).toBe(204);

    // exportação: opt-out fora, CSV para Excel (BOM, ";", fórmula neutralizada) e JSON
    await app.inject({ method: 'POST', url: '/v1/opt-out', headers: AUTH, payload: { chave: 'telefone', valor: '(61) 99333-2211' } });
    const csv = await app.inject({ method: 'GET', url: '/v1/empresas/exportar?formato=csv&uf=DF', headers: AUTH });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/ionext-empresas-\d{4}-\d{2}-\d{2}\.csv/);
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    const [cab, ...dados] = csv.body.slice(1).trim().split('\r\n');
    expect(cab!.split(';')).toContain('telefone_principal');
    expect(dados).toHaveLength(1);
    expect(dados[0]!.startsWith("'=Clínica Fórmula;")).toBe(true);
    expect(dados[0]).toContain('(61) 99444-3322');
    expect(dados[0]).toContain('contato@formula.com.br');
    const json = (await app.inject({ method: 'GET', url: '/v1/empresas/exportar?formato=json', headers: AUTH })).json();
    expect(json.total).toBe(1);
    expect(json.empresas[0]).toMatchObject({ nome_fantasia: '=Clínica Fórmula', telefone_principal: '+5561994443322' });
  });

  it('resultados: abordadas, respostas, reuniões e ganhos por segmento, bairro e mensagem', async () => {
    const mk = (n: number, bairro: string, seg: string) => candidata({
      nome_fantasia: `Clínica R${n}`, segmento: seg, identificadores: [{ fonte: 'osm', valor: `node/97${n}` }],
      endereco: { uf: 'DF', cidade: 'Brasília', bairro, cep: '70000-000', lat: -15.7 - n / 100, lng: -47.9 },
      contatos: [{ tipo: 'telefone', valor: `(61) 9970${n}-0000`, publico_comercial: true, evidencia_ref: 'osm1' }],
    });
    await ingest([mk(1, 'Asa Norte', 'clinica_odontologica'), mk(2, 'Asa Norte', 'clinica_odontologica'), mk(3, 'Guará', 'academia')]);
    const ops = await sql`select o.id, e.nome_fantasia from oportunidade o join empresa e on e.id = o.empresa_id where e.nome_fantasia like 'Clínica R%' order by 2`;
    const [a, b, c] = ops.map((o) => o.id as string) as [string, string, string];
    const envio = (op: string, tipo: string, horas: number) => sql`
      insert into neo.envio (oportunidade_id, tipo, telefone, destino, teste, status, mensagem, enviado_em)
      values (${op}, ${tipo}, '+55', '+55', false, 'enviado', 'oi', now() - make_interval(hours => ${horas}))`;
    await envio(a, 'primeira', 100); await envio(b, 'primeira', 100); await envio(c, 'primeira', 100);
    await envio(b, 'followup', 20);
    // a respondeu à 1ª mensagem em 1 h e fechou por 3000; b respondeu ao follow-up; c não respondeu
    await sql`insert into interacao (oportunidade_id, canal, direcao, resumo, registrado_por, registrado_em)
              values (${a}, 'whatsapp', 'entrada', 'quero', 'neo', now() - interval '99 hours'),
                     (${b}, 'whatsapp', 'entrada', 'pode ser', 'neo', now() - interval '10 hours')`;
    await sql`update oportunidade set status = 'reuniao' where id = ${a}`;
    await sql`update oportunidade set status = 'ganha', proposta_valor = 3000 where id = ${a}`;
    await sql`update oportunidade set status = 'respondeu' where id = ${b}`;
    // envio de teste não conta
    await sql`insert into neo.envio (oportunidade_id, tipo, telefone, destino, teste, status, enviado_em) values (${c}, 'followup', '+55', '+55', true, 'enviado', now())`;

    const r = (await app.inject({ method: 'GET', url: '/v1/painel/resultados', headers: AUTH })).json();
    expect(r.total).toMatchObject({ abordadas: 3, responderam: 2, reunioes: 1, ganhas: 1, valor_ganho: 3000, minutos_ate_resposta: 2730 });
    expect(r.por_segmento[0]).toMatchObject({ nome: 'clinica_odontologica', abordadas: 2, responderam: 2, ganhas: 1 });
    expect(r.por_bairro.map((x: { nome: string }) => x.nome)).toEqual(['Asa Norte', 'Guará']);
    expect(r.por_mensagem).toEqual(expect.arrayContaining([{ nome: '1ª mensagem', responderam: 1 }, { nome: 'Follow-up', responderam: 1 }]));
    const ultimos7 = (await app.inject({ method: 'GET', url: '/v1/painel/resultados?periodo=7', headers: AUTH })).json();
    expect(ultimos7.total.abordadas).toBe(3);
    expect((await app.inject({ method: 'GET', url: '/v1/painel/resultados?periodo=5', headers: AUTH })).statusCode).toBe(400);
  });

  it('Motor 02: fila de auditoria, diagnóstico B/C/D, oportunidade e bloqueio para o Neo', async () => {
    const comSite = candidata({
      nome_fantasia: 'Clínica Com Site', identificadores: [{ fonte: 'osm', valor: 'node/980' }],
      contatos: [{ tipo: 'telefone', valor: '(61) 99222-1100', publico_comercial: true, evidencia_ref: 'osm1' }],
      verificacoes: { ...verificacoesSemSite, V4: { status: 'site_encontrado', url: 'https://clinicacomsite.com.br/', acessivel: true } },
    });
    await ingest([comSite]);
    const [p] = await sql`select e.id, p.classificacao, p.url_site from empresa e join presenca_digital p on p.empresa_id = e.id where e.nome_fantasia = 'Clínica Com Site'`;
    expect(p).toMatchObject({ classificacao: 'SITE_EXISTENTE', url_site: 'https://clinicacomsite.com.br/' });
    const empresaId = p!.id as string;
    expect((await sql`select count(*)::int as n from oportunidade where empresa_id = ${empresaId}`)[0]!.n).toBe(0); // sem auditoria, sem oportunidade

    const reservar = async () => (await app.inject({ method: 'POST', url: '/v1/auditorias/reservar', headers: AUTH, payload: { limite: 5 } })).json();
    const r1 = await reservar();
    expect(r1.itens).toHaveLength(1);
    expect(r1.itens[0]).toMatchObject({ empresa_id: empresaId, url: 'https://clinicacomsite.com.br/', tentativas: 1, motivo: 'novo' });
    expect((await reservar()).itens).toHaveLength(0); // já reservada

    // falha temporária: volta para a fila mais tarde
    const f = await app.inject({ method: 'POST', url: `/v1/auditorias/${empresaId}/falha`, headers: AUTH, payload: { erro: 'PageSpeed: 429' } });
    expect(new Date(f.json().proxima_tentativa).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect((await reservar()).itens).toHaveLength(0);
    // "auditar de novo" no painel fura a fila
    await app.inject({ method: 'POST', url: `/v1/empresas/${empresaId}/auditar`, headers: AUTH });
    expect((await reservar()).itens[0]).toMatchObject({ motivo: 'manual', tentativas: 1 });

    const achado = (codigo: string, gravidade: string) => ({ codigo, gravidade, titulo: codigo, detalhe: 'x', pagina: 'https://clinicacomsite.com.br/', evidencia: 'y', recomendacao: 'z', servico: 'reformulação do site' });
    const diag = {
      motor: 'audit@0.1.0', empresa_id: empresaId, url: 'https://clinicacomsite.com.br/', url_final: 'https://clinicacomsite.com.br/',
      executada_em: new Date().toISOString(),
      psi: { mobile: { estrategia: 'mobile', desempenho: 21, seo: 70, acessibilidade: 80, boas_praticas: 75, lcp_ms: 7000, cls: 0.2, tbt_ms: 900, viewport_ok: false, https_ok: true, url_final: null, screenshot: 'data:image/jpeg;base64,AAAA' }, desktop: null },
      paginas: [{ url: 'https://clinicacomsite.com.br/', status: 200 }],
      achados: [achado('muito_lento_celular', 'grave'), achado('sem_versao_celular', 'grave'), achado('sem_atendimento_automatico', 'oportunidade')],
      pontos_positivos: [{ codigo: 'https', titulo: 'Conexão segura', detalhe: 'ok' }],
      resumo: 'Site desatualizado: muito lento no celular e não está adaptado para celular.',
      servicos_recomendados: ['reformulação do site'], classe: 'D', // classe errada de propósito: a Central recalcula
      sinais: { viewport: false },
    };
    const res = await app.inject({ method: 'POST', url: '/v1/auditorias', headers: AUTH, payload: diag });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ classe: 'B', oportunidade: 'B' });
    const [op] = await sql`select id, tipo, status, lead_score from oportunidade where empresa_id = ${empresaId}`;
    expect(op).toMatchObject({ tipo: 'B', status: 'nova' });
    const ficha = (await app.inject({ method: 'GET', url: `/v1/empresas/${empresaId}`, headers: AUTH })).json();
    expect(ficha.auditorias[0]).toMatchObject({ classe: 'B', resumo: diag.resumo, screenshots: ['data:image/jpeg;base64,AAAA'] });
    expect(ficha.auditorias[0].psi.mobile.screenshot).toBeNull(); // o print fica só em screenshots
    expect(ficha.auditoria_pedido).toBeNull();
    expect(ficha.validacao.fontes).toEqual(expect.arrayContaining(['pagespeed', 'crawler']));
    expect((await reservar()).itens).toHaveLength(0); // auditada há menos de 90 dias

    // o Neo ainda não aborda B/C/D
    const apr = await app.inject({ method: 'PATCH', url: `/v1/oportunidades/${op!.id}`, headers: AUTH, payload: { status: 'aprovada_para_contato' } });
    expect(apr.statusCode).toBe(409);
    const lote = await app.inject({ method: 'POST', url: '/v1/oportunidades/status-em-lote', headers: AUTH, payload: { ids: [op!.id], status: 'aprovada_para_contato' } });
    expect(lote.json()).toEqual({ atualizadas: 0 });
    expect((await app.inject({ method: 'POST', url: '/v1/auditorias', headers: AUTH, payload: { ...diag, motor: 'x' } })).statusCode).toBe(400);
  });

  it('não deixa criar a mesma busca enquanto outra igual está ativa', async () => {
    const corpo = { uf: 'DF', cidade: 'Taguatinga', segmento: 'clinica_medica', bairros: ['Centro', 'Norte'] };
    const a = await app.inject({ method: 'POST', url: '/v1/buscas', headers: AUTH, payload: corpo });
    expect(a.statusCode).toBe(201);
    const b = await app.inject({ method: 'POST', url: '/v1/buscas', headers: AUTH,
      payload: { ...corpo, cidade: 'TAGUATINGA ', bairros: ['norte', 'Centro'], quantidade_desejada: 50 } });
    expect(b.statusCode).toBe(409);
    expect(b.json().busca_id).toBe(a.json().id);
    const outra = await app.inject({ method: 'POST', url: '/v1/buscas', headers: AUTH, payload: { ...corpo, bairros: ['Sul'] } });
    expect(outra.statusCode).toBe(201);
    await app.inject({ method: 'POST', url: `/v1/buscas/${a.json().id}/cancelar`, headers: AUTH });
    await app.inject({ method: 'POST', url: `/v1/buscas/${outra.json().id}/cancelar`, headers: AUTH });
    expect((await app.inject({ method: 'POST', url: '/v1/buscas', headers: AUTH, payload: corpo })).statusCode).toBe(201);
  });

  it('cancela busca em andamento e o motor não a reativa', async () => {
    const criada = (await app.inject({ method: 'POST', url: '/v1/buscas', headers: AUTH,
      payload: { uf: 'DF', cidade: 'Brasília', segmento: 'clinica_odontologica' } })).json();
    await app.inject({ method: 'PATCH', url: `/v1/buscas/${criada.id}`, headers: AUTH, payload: { status: 'executando', total_celulas: 10 } });
    const c = await app.inject({ method: 'POST', url: `/v1/buscas/${criada.id}/cancelar`, headers: AUTH });
    expect(c.json().status).toBe('cancelada');
    const motor = await app.inject({ method: 'PATCH', url: `/v1/buscas/${criada.id}`, headers: AUTH, payload: { status: 'concluida', concluidas: 3 } });
    expect(motor.json()).toMatchObject({ status: 'cancelada', concluidas: 3 });
    expect((await app.inject({ method: 'POST', url: `/v1/buscas/${criada.id}/cancelar`, headers: AUTH })).statusCode).toBe(409);
  });

  it('exclui a busca sem apagar as empresas encontradas', async () => {
    const id = (await app.inject({ method: 'POST', url: '/v1/buscas', headers: AUTH,
      payload: { uf: 'GO', cidade: 'Goiânia', segmento: 'academia' } })).json().id as string;
    const [emp] = await sql`insert into empresa (nome_fantasia, nome_normalizado) values ('Academia Teste', 'academia teste') returning id`;
    await sql`insert into busca_resultado (busca_id, chave, empresa_id, acao) values (${id}, 'teste:1', ${emp!.id}, 'criada')`;
    const [antes] = await sql`select count(*)::int as n from empresa`;
    await sql`update busca set status = 'executando' where id = ${id}`;
    expect((await app.inject({ method: 'DELETE', url: `/v1/buscas/${id}`, headers: AUTH })).statusCode).toBe(409);
    await sql`update busca set status = 'concluida' where id = ${id}`;
    expect((await app.inject({ method: 'DELETE', url: `/v1/buscas/${id}`, headers: AUTH })).statusCode).toBe(204);
    const [depois] = await sql`select count(*)::int as n from empresa`;
    expect(depois!.n).toBe(antes!.n);
    expect((await sql`select 1 from busca_resultado where busca_id = ${id}`).length).toBe(0);
    expect((await app.inject({ method: 'GET', url: `/v1/buscas/${id}`, headers: AUTH })).statusCode).toBe(404);
  });

  it('lista bairros da cidade para o seletor da nova busca', async () => {
    await sql`insert into receita.estabelecimento (cnpj, cnpj_basico, matriz, situacao, cnae_principal, uf, municipio_codigo, municipio_nome, bairro, bairro_normalizado, referencia)
      values ('99000000000101','99000000',true,'ATIVA','8630504','DF','9701','BRASILIA','GUARA II','guara ii','t'),
             ('99000000000102','99000000',true,'ATIVA','8630504','DF','9701','BRASILIA','GUARA II','guara ii','t'),
             ('99000000000103','99000000',true,'ATIVA','8630504','DF','9701','BRASILIA','SETOR DE INDUSTRIAS','setor de industrias','t'),
             ('99000000000104','99000000',true,'BAIXADA','8630504','DF','9701','BRASILIA','LAGO SUL','lago sul','t'),
             ('99000000000105','99000000',true,'ATIVA','4520001','DF','9701','BRASILIA','NOROESTE','noroeste','t')
      on conflict do nothing`;
    const r = await app.inject({ method: 'GET', url: '/v1/bairros?uf=DF&cidade=Bras%C3%ADlia&segmento=clinica_odontologica', headers: AUTH });
    const nomes = r.json().bairros.map((b: { nome: string; total: number }) => `${b.nome}:${b.total}`);
    expect(nomes).toContain('Guara II:2');
    expect(nomes).toContain('Setor de Industrias:1');
    expect(nomes.some((n: string) => n.startsWith('Lago Sul') || n.startsWith('Noroeste'))).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/v1/bairros?uf=DF', headers: AUTH })).statusCode).toBe(400);
    await sql`delete from receita.estabelecimento where cnpj like '99000000%'`;
  });

  it('bloqueia o IP depois de 5 senhas erradas', async () => {
    const { criarLimitadorLogin } = await import('../src/app.ts');
    const l = criarLimitadorLogin(5, 60_000);
    for (let i = 0; i < 4; i++) l.errou('1.1.1.1');
    expect(l.bloqueado('1.1.1.1')).toBe(0);
    l.errou('1.1.1.1');
    expect(l.bloqueado('1.1.1.1')).toBeGreaterThan(0);
    expect(l.bloqueado('2.2.2.2')).toBe(0);
    l.acertou('1.1.1.1');
    expect(l.bloqueado('1.1.1.1')).toBe(0);
  });

  it('serve ícone, fontes e tema do painel', async () => {
    const icone = await app.inject({ method: 'GET', url: '/painel/icone.svg' });
    expect(icone.headers['content-type']).toContain('image/svg+xml');
    const fonte = await app.inject({ method: 'GET', url: '/painel/fontes/archivo-latin-standard-normal.woff2' });
    expect(fonte.statusCode).toBe(200);
    expect(fonte.headers['content-type']).toBe('font/woff2');
    expect((await app.inject({ method: 'GET', url: '/painel/fontes/..%2F..%2Fpackage.json' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/painel/tema.js' })).statusCode).toBe(200);
  });
});
