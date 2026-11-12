/**
 * Fase 5 — funções do schema neo (o que o n8n chama). Banco DESCARTÁVEL via TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { criarApp } from '../src/app.ts';
import { conectar, type Sql } from '../src/db.ts';

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
