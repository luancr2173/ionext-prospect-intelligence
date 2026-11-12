import type { EmpresaCandidata, IngestCandidatas, RespostaIngest } from '@ionext/contratos';
import {
  classificarPresenca, cnpjValido, dominioProprioDoEmail, limparCnpj,
  normalizarCep, normalizarEmail, normalizarNome, normalizarTelefone, type Verificacoes,
} from '@ionext/dominio';
import type { Sql, Tx } from '../db.ts';
import { encontrarDuplicata } from './dedup.ts';
import { recalcularOportunidade } from './oportunidade.ts';

type Resultado = RespostaIngest['resultados'][number];

interface ContatoNormalizado {
  tipo: EmpresaCandidata['contatos'][number]['tipo'];
  valor: string;
  valor_normalizado: string;
  publico_comercial: boolean;
  evidencia_ref: string;
}

function normalizarContatos(c: EmpresaCandidata, avisos: string[]): ContatoNormalizado[] {
  const out: ContatoNormalizado[] = [];
  for (const ct of c.contatos) {
    let n: string | null;
    if (ct.tipo === 'telefone' || ct.tipo === 'whatsapp') n = normalizarTelefone(ct.valor);
    else if (ct.tipo === 'email') n = normalizarEmail(ct.valor);
    else n = ct.valor.trim().toLowerCase().replace(/\/+$/, '');
    if (!n) { avisos.push(`contato ${ct.tipo} "${ct.valor}" descartado: formato inválido`); continue; }
    out.push({ ...ct, valor_normalizado: n });
  }
  return out;
}

/** Chave estável da candidata dentro de uma busca (idempotência). */
function chaveCandidata(c: EmpresaCandidata, cnpj: string | null): string {
  if (cnpj) return `cnpj:${cnpj}`;
  const idf = c.identificadores[0];
  if (idf) return `${idf.fonte}:${idf.valor}`;
  return `nome:${normalizarNome(c.nome_fantasia)}|${normalizarCep(c.endereco.cep ?? '') ?? c.endereco.bairro ?? ''}`;
}

async function bloqueadaPorOptOut(tx: Tx, cnpj: string | null, contatos: ContatoNormalizado[]): Promise<boolean> {
  const tels = contatos.filter((c) => c.tipo === 'telefone' || c.tipo === 'whatsapp').map((c) => c.valor_normalizado);
  const emails = contatos.filter((c) => c.tipo === 'email').map((c) => c.valor_normalizado);
  const dominios = emails.map(dominioProprioDoEmail).filter((d): d is string => !!d);
  const [r] = await tx<{ b: boolean }[]>`
    select exists (select 1 from opt_out where
      (chave = 'cnpj' and valor = ${cnpj}::text)
      or (chave = 'telefone' and valor = any(${tels}::text[]))
      or (chave = 'email' and valor = any(${emails}::text[]))
      or (chave = 'dominio' and valor = any(${dominios}::text[]))) as b`;
  return r?.b ?? false;
}

async function ingerirUma(tx: Tx, c: EmpresaCandidata, buscaId: string | null, motor: string, indice: number): Promise<Resultado> {
  const avisos: string[] = [];

  let cnpj: string | null = null;
  if (c.cnpj) {
    const limpo = limparCnpj(c.cnpj);
    if (cnpjValido(limpo)) cnpj = limpo;
    else avisos.push(`CNPJ "${c.cnpj}" inválido: ignorado`);
  }
  const contatos = normalizarContatos(c, avisos);

  // LGPD: quem pediu para não ser contatado não volta para a base.
  if (await bloqueadaPorOptOut(tx, cnpj, contatos)) {
    return { indice, empresa_id: null, acao: 'bloqueada_opt_out', classificacao: null, lead_score: null, avisos };
  }

  const chave = chaveCandidata(c, cnpj);
  if (buscaId) {
    const [ja] = await tx<{ empresa_id: string; acao: Resultado['acao'] }[]>`
      select empresa_id, acao from busca_resultado where busca_id = ${buscaId} and chave = ${chave}`;
    if (ja) {
      const r = await recalcularOportunidade(tx, ja.empresa_id);
      return { indice, empresa_id: ja.empresa_id, acao: ja.acao, classificacao: r.classificacao,
               lead_score: r.score?.lead_score ?? null, avisos: [...avisos, 'já ingerida nesta busca'] };
    }
  }

  const nome_normalizado = normalizarNome(c.nome_fantasia);
  const cep = c.endereco.cep ? normalizarCep(c.endereco.cep) : null;
  if (c.endereco.cep && !cep) avisos.push(`CEP "${c.endereco.cep}" inválido: ignorado`);
  const lat = c.endereco.lat ?? null;
  const lng = c.endereco.lng ?? null;

  const dup = await encontrarDuplicata(tx, {
    cnpj,
    identificadores: c.identificadores,
    telefones: contatos.filter((x) => x.tipo === 'telefone' || x.tipo === 'whatsapp').map((x) => x.valor_normalizado),
    nome_normalizado, cep, lat, lng,
  });

  const campos = {
    cnpj, nome_fantasia: c.nome_fantasia, razao_social: c.razao_social ?? null, nome_normalizado,
    segmento: c.segmento ?? null, cnae_principal: c.cnae_principal ?? null, porte: c.porte ?? null,
    data_abertura: c.data_abertura ?? null, situacao_receita: c.situacao_receita ?? null,
    pais: c.endereco.pais, uf: c.endereco.uf?.toUpperCase() ?? null, cidade: c.endereco.cidade ?? null,
    bairro: c.endereco.bairro ?? null, endereco: c.endereco.logradouro ?? null, cep, lat, lng,
  };

  let empresaId: string;
  let acao: Resultado['acao'];
  if (dup.tipo === 'existente') {
    empresaId = dup.empresa_id;
    acao = 'mesclada';
    // Só preenche lacunas: nunca sobrescreve dado já existente.
    await tx`
      update empresa set
        cnpj = coalesce(cnpj, ${campos.cnpj}), razao_social = coalesce(razao_social, ${campos.razao_social}),
        segmento = coalesce(segmento, ${campos.segmento}), cnae_principal = coalesce(cnae_principal, ${campos.cnae_principal}),
        porte = coalesce(porte, ${campos.porte}), data_abertura = coalesce(data_abertura, ${campos.data_abertura}::date),
        situacao_receita = coalesce(situacao_receita, ${campos.situacao_receita}),
        uf = coalesce(uf, ${campos.uf}), cidade = coalesce(cidade, ${campos.cidade}), bairro = coalesce(bairro, ${campos.bairro}),
        endereco = coalesce(endereco, ${campos.endereco}), cep = coalesce(cep, ${campos.cep}),
        lat = coalesce(lat, ${campos.lat}::float8), lng = coalesce(lng, ${campos.lng}::float8)
      where id = ${empresaId}`;
    avisos.push(`mesclada por ${dup.motivo}`);
  } else {
    const [nova] = await tx<{ id: string }[]>`insert into empresa ${tx(campos)} returning id`;
    empresaId = nova!.id;
    acao = dup.tipo === 'revisao' ? 'revisao_merge' : 'criada';
    if (dup.tipo === 'revisao') {
      await tx`insert into revisao_merge (empresa_a, empresa_b, similaridade, motivo)
               values (${dup.empresa_id}, ${empresaId}, ${dup.similaridade}, ${dup.motivo})`;
      avisos.push(`possível duplicata de ${dup.empresa_id} (${dup.motivo}): enviada para revisão`);
    }
  }

  // Evidências primeiro, para ligar contatos e presença a elas.
  const refParaId = new Map<string, string>();
  for (const e of c.evidencias) {
    const [row] = await tx<{ id: string }[]>`
      insert into evidencia (empresa_id, fonte, url, coletado_em, expira_em, confiabilidade, payload)
      values (${empresaId}, ${e.fonte}, ${e.url ?? null}, ${e.coletado_em}, ${e.expira_em ?? null},
              ${e.confiabilidade}, ${tx.json({ ...e.payload, motor } as never)})
      returning id`;
    refParaId.set(e.ref, row!.id);
  }

  for (const idf of c.identificadores) {
    const r = await tx`insert into identificador_externo (empresa_id, fonte, valor)
                       values (${empresaId}, ${idf.fonte}, ${idf.valor}) on conflict do nothing`;
    if (r.count === 0) {
      const [dono] = await tx<{ empresa_id: string }[]>`
        select empresa_id from identificador_externo where fonte = ${idf.fonte} and valor = ${idf.valor}`;
      if (dono && dono.empresa_id !== empresaId) avisos.push(`identificador ${idf.fonte}:${idf.valor} já pertence a ${dono.empresa_id}`);
    }
  }

  for (const ct of contatos) {
    await tx`
      insert into contato (empresa_id, tipo, valor, valor_normalizado, publico_comercial, evidencia_id)
      values (${empresaId}, ${ct.tipo}, ${ct.valor}, ${ct.valor_normalizado}, ${ct.publico_comercial},
              ${refParaId.get(ct.evidencia_ref) ?? null})
      on conflict (empresa_id, tipo, valor_normalizado) do update
        set publico_comercial = contato.publico_comercial or excluded.publico_comercial,
            evidencia_id = coalesce(contato.evidencia_id, excluded.evidencia_id)`;
  }

  if (c.verificacoes && c.verificado_em) {
    const cls = classificarPresenca(c.verificacoes as Verificacoes);
    await tx`
      insert into presenca_digital (empresa_id, classificacao, url_site, verificacoes, confiabilidade,
                                    motor_versao, verificado_em, evidencia_ids)
      values (${empresaId}, ${cls.classificacao}, ${cls.url_site},
              ${tx.json({ ...c.verificacoes, motivos: cls.motivos } as never)}, ${cls.confiabilidade},
              ${motor}, ${c.verificado_em}, ${[...refParaId.values()]}::uuid[])
      on conflict (empresa_id) do update set
        classificacao = excluded.classificacao, url_site = excluded.url_site, verificacoes = excluded.verificacoes,
        confiabilidade = excluded.confiabilidade, motor_versao = excluded.motor_versao,
        verificado_em = excluded.verificado_em, evidencia_ids = excluded.evidencia_ids
      where presenca_digital.verificado_em <= excluded.verificado_em`;
  }

  const r = await recalcularOportunidade(tx, empresaId);

  if (buscaId) {
    await tx`insert into busca_resultado (busca_id, chave, empresa_id, acao)
             values (${buscaId}, ${chave}, ${empresaId}, ${acao})`;
  }

  return { indice, empresa_id: empresaId, acao, classificacao: r.classificacao, lead_score: r.score?.lead_score ?? null, avisos };
}

/** Cada candidata em sua própria transação: uma falha não derruba o lote. */
export async function ingerirCandidatas(sql: Sql, lote: IngestCandidatas): Promise<RespostaIngest> {
  const resultados: Resultado[] = [];
  if (lote.busca_id) {
    const [b] = await sql`select 1 from busca where id = ${lote.busca_id}`;
    if (!b) throw Object.assign(new Error(`busca ${lote.busca_id} não existe`), { statusCode: 422 });
  }
  for (const [i, c] of lote.candidatas.entries()) {
    try {
      resultados.push(await sql.begin((tx) => ingerirUma(tx, c, lote.busca_id ?? null, lote.motor, i)) as Resultado);
    } catch (err) {
      // A transação dessa candidata foi revertida; o motor deve reenviar (o reenvio é idempotente).
      resultados.push({ indice: i, empresa_id: null, acao: 'erro', classificacao: null, lead_score: null,
                        avisos: [`erro: ${(err as Error).message}`] });
    }
  }
  return { resultados };
}
