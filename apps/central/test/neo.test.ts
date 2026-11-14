/**
 * Fase 5 — funções do schema neo (o que o n8n chama). Banco DESCARTÁVEL via TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarApp } from '../src/app.ts';
import { conectar, type Sql } from '../src/db.ts';
import { recalcularOportunidade } from '../src/servicos/oportunidade.ts';

const URL = process.env.TEST_DATABASE_URL;
const SEGREDO = 'n'.repeat(40);
const AUTH = { authorization: `Bearer ${SEGREDO}` };
const AGORA = new Date().toISOString();

function candidata(nome: string, telefone: string, cnpjBase: string) {
  return {
    nome_fantasia: nome, segmento: 'clinica_odontologica', situacao_receita: 'ATIVA',
    endereco: { uf: 'DF', cidade: 'Brasília', bairro: 'Asa Norte' },
    identificadores: [{ fonte: 'receita', valor: cnpjBase }],
    contatos: [
      { tipo: 'telefone', valor: telefone, publico_comercial: true, evidencia_ref: 'rf' },
      { tipo: 'instagram', valor: `https://instagram.com/${cnpjBase}`, publico_comercial: true, evidencia_ref: 'rf' },
    ],
    verificacoes: { V1: { status: 'nao_executado' }, V2: { status: 'nada_encontrado' }, V3: { status: 'nao_aplicavel' },
                    V4: { status: 'nada_encontrado' }, V5: { status: 'nada_encontrado' }, V6: { status: 'executado', redes: ['instagram'] } },
    verificado_em: AGORA,
    evidencias: [{ ref: 'rf', fonte: 'receita', url: null, coletado_em: AGORA, payload: {} }],
  };
}

describe.skipIf(!URL)('Neo (schema neo)', () => {
  let sql: Sql;
  let app: ReturnType<typeof criarApp>;

  beforeAll(async () => {
    sql = conectar(URL!);
    app = criarApp(sql, new Map([[SEGREDO, 'teste']]), { logger: false });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await sql.end(); });

  const cfg = (chave: string, valor: string) => sql`update neo.config set valor = ${valor} where chave = ${chave}`;
  const reservar = (n = 5) => sql`select * from neo.reservar(${n})`;

  /** Cria e aprova uma oportunidade; devolve o id. */
  async function aprovada(nome: string, telefone: string, base: string) {
    const r = await app.inject({ method: 'POST', url: '/v1/ingest/candidatas', headers: AUTH,
      payload: { motor: 'prospecting@0.1.0', candidatas: [candidata(nome, telefone, base)] } });
    const empresaId = r.json().resultados[0].empresa_id;
    const [o] = await sql`update oportunidade set status = 'aprovada_para_contato' where empresa_id = ${empresaId} returning id`;
    return o!.id as string;
  }

  beforeEach(async () => {
    await sql`truncate empresa, evidencia, busca, opt_out cascade`;
    await sql`truncate neo.envio`;
    // janela sempre aberta nos testes
    await cfg('hora_inicio', '0'); await cfg('hora_fim', '24'); await cfg('dias_semana', '1,2,3,4,5,6,7');
    await cfg('limite_diario', '15'); await cfg('modo_teste', 'true'); await cfg('numero_teste', '61 99999-0000');
    await cfg('followup_dias', '3');
  });

  it('modo teste: envia para o número de teste e não mexe no funil', async () => {
    const op = await aprovada('Clínica Neo Um', '(61) 99876-5432', 'neo1');
    const [r] = await reservar();
    expect(r).toMatchObject({ oportunidade_id: op, tipo: 'primeira', telefone: '+5561998765432', destino: '+5561999990000', teste: true, instancia: 'TESTE' });
    expect(r!.contexto.empresa.nome).toBe('Clínica Neo Um');
    expect(r!.contexto.diagnostico.presenca).toBe('SOMENTE_REDES');
    expect(r!.contexto.diagnostico.redes).toEqual(['https://instagram.com/neo1']);
    expect(r!.contexto.regras.join(' ')).toContain('Não invente');

    const [ok] = await sql`select neo.registrar_envio(${r!.envio_id}, 'Olá! Sou o Neo, da IONEXT...', true) as r`;
    expect(ok!.r).toEqual({ ok: true, teste: true });
    const [o] = await sql`select status from oportunidade where id = ${op}`;
    expect(o!.status).toBe('aprovada_para_contato');
    expect(await reservar()).toHaveLength(0); // não repete no teste
  });

  it('modo real: muda para abordada, registra interação e respeita a cota diária', async () => {
    await cfg('modo_teste', 'false'); await cfg('limite_diario', '1');
    const op1 = await aprovada('Clínica Neo A', '61 99876-0001', 'neoa');
    await aprovada('Clínica Neo B', '61 99876-0002', 'neob');
    const lote = await reservar();
    expect(lote).toHaveLength(1);
    expect(lote[0]!.destino).toBe(lote[0]!.telefone);
    await sql`select neo.registrar_envio(${lote[0]!.envio_id}, 'mensagem', true)`;
    const [o] = await sql`select status from oportunidade where id = ${lote[0]!.oportunidade_id}`;
    expect(o!.status).toBe('abordada');
    const [i] = await sql`select direcao, registrado_por from interacao where oportunidade_id = ${lote[0]!.oportunidade_id}`;
    expect(i).toEqual({ direcao: 'saida', registrado_por: 'neo' });
    expect(await reservar()).toHaveLength(0); // cota do dia esgotada
    void op1;
  });

  it('só celular: telefone fixo não entra na fila', async () => {
    await aprovada('Clínica Fixo', '(61) 3322-1100', 'fixo');
    expect(await reservar()).toHaveLength(0);
  });

  it('celular no formato antigo (8 dígitos) ganha o 9 na frente', async () => {
    await aprovada('Clínica Antiga', '(61) 8123-4567', 'antiga');
    const [r] = await reservar();
    expect(r!.telefone).toBe('+5561981234567');
  });

  it('janela: sábado só até o meio-dia, domingo fechado', async () => {
    await cfg('dias_semana', '1,2,3,4,5,6'); await cfg('hora_inicio', '9'); await cfg('hora_fim', '18');
    // ::text antes de ::timestamp: senão o driver converte a string pelo fuso local
    const aberta = async (t: string) => (await sql`select neo._janela_aberta(${t}::text::timestamp) as a`)[0]!.a;
    expect(await aberta('2026-11-13 17:30')).toBe(true);   // sexta
    expect(await aberta('2026-11-13 18:00')).toBe(false);
    expect(await aberta('2026-11-14 11:59')).toBe(true);   // sábado
    expect(await aberta('2026-11-14 12:00')).toBe(false);
    expect(await aberta('2026-11-14 08:59')).toBe(false);
    expect(await aberta('2026-11-15 10:00')).toBe(false);  // domingo
    await cfg('hora_fim_sabado', '');
    expect(await aberta('2026-11-14 15:00')).toBe(true);   // vazio = mesmo horário dos outros dias
    await cfg('hora_fim_sabado', '12');
  });

  it('oportunidade com site (B/C/D) não entra na fila do Neo, mesmo aprovada', async () => {
    const op = await aprovada('Clínica Tipo B', '61 99876-0050', 'tipob');
    await sql`update oportunidade set tipo = 'B' where id = ${op}`;
    expect(await reservar()).toHaveLength(0);
    await sql`update oportunidade set tipo = 'A' where id = ${op}`;
    expect(await reservar()).toHaveLength(1);
  });

  it('número sem WhatsApp não volta para a fila', async () => {
    await aprovada('Clínica Sem Zap', '61 99876-0009', 'semzap');
    const [r] = await reservar();
    const [x] = await sql`select neo.registrar_sem_whatsapp(${r!.envio_id}) as r`;
    expect(x!.r).toEqual({ ok: true, saiu_da_fila: false }); // modo teste não mexe no funil
    expect(await reservar()).toHaveLength(0);
    const [w] = await sql`select count(*)::int as n from neo._whatsapp((select empresa_id from oportunidade where id = ${r!.oportunidade_id}))`;
    expect(w!.n).toBe(0); // o painel deixa de mostrar esse número como WhatsApp
  });

  it('fora do modo teste, sem WhatsApp tira da fila do Neo; com outro celular, tenta o outro', async () => {
    await cfg('modo_teste', 'false');
    const op = await aprovada('Clínica Sem Zap Real', '61 99876-0019', 'semzapreal');
    const [r] = await reservar();
    const [x] = await sql`select neo.registrar_sem_whatsapp(${r!.envio_id}) as r`;
    expect(x!.r).toEqual({ ok: true, saiu_da_fila: true });
    const [o] = await sql`select status from oportunidade where id = ${op}`;
    expect(o!.status).toBe('revisada');

    const op2 = await aprovada('Clínica Dois Celulares', '61 99876-0020', 'doiscel');
    const [{ empresa_id }] = await sql`select empresa_id from oportunidade where id = ${op2}` as unknown as [{ empresa_id: string }];
    await sql`insert into contato (empresa_id, tipo, valor, valor_normalizado, publico_comercial)
              values (${empresa_id}, 'telefone', '61 99876-0021', '+5561998760021', true)`;
    const [r2] = await reservar();
    await sql`select neo.registrar_sem_whatsapp(${r2!.envio_id})`;
    const [o2] = await sql`select status from oportunidade where id = ${op2}`;
    expect(o2!.status).toBe('aprovada_para_contato');
    const [r3] = await reservar();
    expect(r3!.telefone).not.toBe(r2!.telefone);
  });

  it('depois de 3 falhas a oportunidade sai da fila', async () => {
    await aprovada('Clínica Falha', '61 99876-0010', 'falha');
    for (const _ of [1, 2, 3]) {
      const [r] = await reservar();
      expect(r).toBeTruthy();
      await sql`select neo.registrar_envio(${r!.envio_id}, 'x', false, 'Validação: teste')`;
    }
    expect(await reservar()).toHaveLength(0);
  });

  it('classificação mudou (achou o site): oportunidade A fica desatualizada e sai da fila; volta se mudar de novo', async () => {
    const op = await aprovada('Clínica Achou Site', '61 99876-0011', 'achou');
    const [{ empresa_id }] = await sql`select empresa_id from oportunidade where id = ${op}` as unknown as [{ empresa_id: string }];
    await sql`update presenca_digital set classificacao = 'SITE_EXISTENTE' where empresa_id = ${empresa_id}`;
    await recalcularOportunidade(sql, empresa_id);
    const [o] = await sql`select status from oportunidade where id = ${op}`;
    expect(o!.status).toBe('obsoleta');
    expect(await reservar()).toHaveLength(0);

    await sql`update presenca_digital set classificacao = 'SEM_SITE' where empresa_id = ${empresa_id}`;
    await recalcularOportunidade(sql, empresa_id);
    const [o2] = await sql`select status from oportunidade where id = ${op}`;
    expect(o2!.status).toBe('nova');
  });

  it('ao_receber: resposta da clínica traz o contexto, marca "respondeu" e reconhece opt-out', async () => {
    await cfg('modo_teste', 'false');
    const op = await aprovada('Clínica Resposta', '61 99876-0020', 'resp');
    const [r] = await reservar();
    await sql`select neo.registrar_envio(${r!.envio_id}, 'Olá! Aqui é o Neo...', true)`;

    const [a] = await sql`select neo.ao_receber('556199876002' || '0@s.whatsapp.net', 'Quero saber mais') as r`;
    expect(a!.r).toMatchObject({ prospeccao: true, teste: false, pediu_para_nao_receber: false, primeira_mensagem: 'Olá! Aqui é o Neo...' });
    expect(a!.r.contexto.empresa.nome).toBe('Clínica Resposta');
    const [o] = await sql`select status from oportunidade where id = ${op}`;
    expect(o!.status).toBe('respondeu');

    const [b] = await sql`select neo.ao_receber('5561998760020', 'Não tenho interesse, obrigado') as r`;
    expect(b!.r.pediu_para_nao_receber).toBe(true);
    const [bloq] = await sql`select count(*)::int as n from opt_out where valor = '+5561998760020'`;
    expect(bloq!.n).toBe(1);

    const [c] = await sql`select neo.ao_receber('5561911112222', 'oi') as r`;
    expect(c!.r).toEqual({ prospeccao: false });
  });

  it('conversa: respostas do Neo na linha do tempo, pausa ao assumir e opt-out duvidoso em revisão', async () => {
    await cfg('modo_teste', 'false');
    const op = await aprovada('Clínica Conversa', '61 99876-0040', 'conversa');
    const [r] = await reservar();
    await sql`select neo.registrar_envio(${r!.envio_id}, 'Olá! Aqui é o Neo...', true)`;
    await sql`select neo.ao_receber('5561998760040@s.whatsapp.net', 'Como funciona?')`;

    // o fluxo de atendimento separa os balões com barra invertida
    const [g] = await sql`select neo.registrar_resposta_neo('5561998760040@s.whatsapp.net', ${'Claro!\\Funciona assim'}) as r`;
    expect(g!.r).toEqual({ ok: true });
    const [i] = await sql`select resumo from interacao where oportunidade_id = ${op} and resumo like 'Neo:%'`;
    expect(i!.resumo).toBe('Neo: Claro!\nFunciona assim');
    const [fora] = await sql`select neo.registrar_resposta_neo('5561911112222', 'oi') as r`;
    expect(fora!.r).toEqual({ ok: false });

    // assumir: o Neo não responde nem manda follow-up
    expect((await sql`select neo.pode_responder('5561998760040') as p`)[0]!.p).toBe(true);
    await sql`update oportunidade set neo_pausado_em = now() where id = ${op}`;
    const [p] = await sql`select neo.ao_receber('5561998760040', 'Alô?') as r`;
    expect(p!.r).toMatchObject({ prospeccao: true, pausado: true });
    expect((await sql`select neo.pode_responder('5561998760040') as p`)[0]!.p).toBe(false);
    expect((await sql`select neo.pode_responder('5561911112222') as p`)[0]!.p).toBe(true); // fora da prospecção
    await sql`update oportunidade set status = 'abordada' where id = ${op}`;
    await sql`update neo.envio set enviado_em = now() - interval '5 days' where oportunidade_id = ${op}`;
    expect(await reservar()).toHaveLength(0); // sem follow-up enquanto pausado
    await sql`update oportunidade set neo_pausado_em = null where id = ${op}`;
    expect((await reservar()).map((x) => x.tipo)).toEqual(['followup']);

    // opt-out claro x duvidoso: os dois bloqueiam na hora; só o duvidoso vai para revisão
    const op2 = await aprovada('Clínica Agora Não', '61 99876-0041', 'agoranao');
    const [r2] = await reservar();
    await sql`select neo.registrar_envio(${r2!.envio_id}, 'Olá!', true)`;
    await sql`select neo.ao_receber('5561998760041', 'No momento não tenho interesse, quem sabe ano que vem')`;
    const [d] = await sql`select revisao, mensagem, oportunidade_id from opt_out where valor = '+5561998760041'`;
    expect(d).toMatchObject({ revisao: 'pendente', oportunidade_id: op2 });
    expect((await sql`select neo.pode_responder('5561998760041') as p`)[0]!.p).toBe(false);
    await sql`select neo.ao_receber('5561998760040', 'Não quero receber mensagens')`;
    const [c] = await sql`select revisao from opt_out where valor = '+5561998760040'`;
    expect(c!.revisao).toBe('confirmado');
  });

  it('ao_receber no modo teste: liga a resposta do número de teste ao último envio de teste', async () => {
    const op = await aprovada('Clínica Teste Resposta', '61 99876-0021', 'tresp');
    const [r] = await reservar();
    await sql`select neo.registrar_envio(${r!.envio_id}, 'msg de teste', true)`;
    const [a] = await sql`select neo.ao_receber('5561999990000@s.whatsapp.net', 'ok, quero saber mais') as r`;
    expect(a!.r).toMatchObject({ prospeccao: true, teste: true });
    expect(a!.r.contexto.empresa.nome).toBe('Clínica Teste Resposta');
    const [o] = await sql`select status from oportunidade where id = ${op}`;
    expect(o!.status).toBe('aprovada_para_contato');
    // o WhatsApp manda o número sem o nono dígito
    const [b] = await sql`select neo.ao_receber('556199990000@s.whatsapp.net', 'pode explicar?') as r`;
    expect(b!.r).toMatchObject({ prospeccao: true, teste: true });
  });

  it('opt-out bloqueia mesmo com o número em formatos diferentes (com e sem o 9)', async () => {
    await aprovada('Clínica Formato', '(61) 8123-9999', 'formato');
    await sql`select neo.registrar_opt_out('5561981239999@s.whatsapp.net', 'teste')`;
    expect(await reservar()).toHaveLength(0);
  });

  it('portfólio só entra no contexto quando o link estiver configurado', async () => {
    const op = await aprovada('Clínica Portfólio', '61 99876-0030', 'portf');
    await cfg('portfolio_url', '');
    const [a] = await sql`select neo.montar_contexto(${op}) as c`;
    expect(a!.c.portfolio).toBeNull();
    await cfg('portfolio_url', 'https://ionext.com.br/portfolio');
    const [b] = await sql`select neo.montar_contexto(${op}) as c`;
    expect(b!.c.portfolio.url).toBe('https://ionext.com.br/portfolio');
    expect(b!.c.portfolio.como_apresentar).toContain('Nunca diga');
    expect(b!.c.servicos_depois_do_diagnostico.length).toBeGreaterThan(0);
    await cfg('portfolio_url', '');
  });

  it('fora da janela de horário não reserva nada', async () => {
    await aprovada('Clínica Horário', '61 99876-0003', 'hora');
    await cfg('dias_semana', '');
    expect(await reservar()).toHaveLength(0);
  });

  it('modo teste sem número de teste falha alto (não envia para a clínica por engano)', async () => {
    await aprovada('Clínica Sem Teste', '61 99876-0004', 'semteste');
    await cfg('numero_teste', '');
    await expect(reservar()).rejects.toThrow(/numero_teste/);
  });

  it('opt-out pelo WhatsApp descarta e tira da fila', async () => {
    await cfg('modo_teste', 'false');
    const op = await aprovada('Clínica Opt', '61 99876-0005', 'opt');
    const [r] = await sql`select neo.registrar_opt_out('5561998760005@s.whatsapp.net', 'não quero') as r`;
    expect(r!.r).toMatchObject({ ok: true, oportunidades_descartadas: 1 });
    const [o] = await sql`select status from oportunidade where id = ${op}`;
    expect(o!.status).toBe('descartada');
    await sql`update oportunidade set status = 'aprovada_para_contato' where id = ${op}`;
    expect(await reservar()).toHaveLength(0); // bloqueada mesmo se reaprovada
  });

  it('follow-up depois de N dias sem resposta, uma vez só', async () => {
    await cfg('modo_teste', 'false');
    await aprovada('Clínica Follow', '61 99876-0006', 'follow');
    const [r] = await reservar();
    await sql`select neo.registrar_envio(${r!.envio_id}, 'primeira msg', true)`;
    expect(await reservar()).toHaveLength(0);
    await sql`update neo.envio set enviado_em = now() - interval '4 days' where id = ${r!.envio_id}`;
    const [f] = await reservar();
    expect(f).toMatchObject({ tipo: 'followup', mensagem_anterior: 'primeira msg' });
    await sql`select neo.registrar_envio(${f!.envio_id}, 'follow-up', true)`;
    await sql`update neo.envio set enviado_em = now() - interval '10 days'`;
    expect(await reservar()).toHaveLength(0);
  });

  it('resposta da clínica: marca respondeu e o Neo recebe o contexto', async () => {
    await cfg('modo_teste', 'false');
    const op = await aprovada('Clínica Resposta', '61 99876-0007', 'resp');
    const [r] = await reservar();
    await sql`select neo.registrar_envio(${r!.envio_id}, 'primeira msg', true)`;
    const [c] = await sql`select neo.contexto_por_telefone('5561998760007') as c`;
    expect(c!.c).toMatchObject({ prospeccao: true, oportunidade_id: op, primeira_mensagem: 'primeira msg' });
    const [res] = await sql`select neo.registrar_resposta('+55 61 99876-0007', 'Tenho interesse') as r`;
    expect(res!.r).toMatchObject({ prospeccao: true });
    const [o] = await sql`select status from oportunidade where id = ${op}`;
    expect(o!.status).toBe('respondeu');
    const [nao] = await sql`select neo.contexto_por_telefone('5561911112222') as c`;
    expect(nao!.c).toEqual({ prospeccao: false });
  });

  it('usuário do n8n só executa as funções: nenhuma tabela', async () => {
    await aprovada('Clínica Permissão', '61 99876-0008', 'perm');
    const comoN8n = (consulta: string) => sql.begin(async (tx) => {
      await tx`set local role neo_n8n`;
      return tx.unsafe(consulta);
    });
    expect(await comoN8n('select * from neo.reservar(1)')).toHaveLength(1);
    await expect(comoN8n('select * from public.empresa')).rejects.toThrow(/permission denied/);
    await expect(comoN8n('select * from public.contato')).rejects.toThrow(/permission denied/);
    await expect(comoN8n('select * from neo.envio')).rejects.toThrow(/permission denied/);
    await expect(comoN8n("update neo.config set valor = 'false' where chave = 'modo_teste'")).rejects.toThrow(/permission denied/);
    await expect(comoN8n('select neo.montar_contexto(gen_random_uuid())')).rejects.toThrow(/permission denied/);
  });
});
