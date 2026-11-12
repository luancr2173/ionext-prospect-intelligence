/**
 * Layout dos dados abertos do CNPJ (Receita Federal): CSV sem cabeçalho, separador ";", aspas duplas, latin1.
 * Ordem das colunas conforme o dicionário de dados da Receita (LAYOUT_DADOS_ABERTOS_CNPJ / cnpj-metadados).
 */
import { normalizarNome, normalizarTelefone } from '@ionext/dominio';

export const COLUNAS_ESTABELECIMENTO = [
  'cnpj_basico', 'cnpj_ordem', 'cnpj_dv', 'matriz_filial', 'nome_fantasia', 'situacao_cadastral',
  'data_situacao_cadastral', 'motivo_situacao_cadastral', 'nome_cidade_exterior', 'pais',
  'data_inicio_atividades', 'cnae_fiscal', 'cnae_fiscal_secundaria', 'tipo_logradouro', 'logradouro',
  'numero', 'complemento', 'bairro', 'cep', 'uf', 'municipio', 'ddd1', 'telefone1', 'ddd2', 'telefone2',
  'ddd_fax', 'fax', 'correio_eletronico', 'situacao_especial', 'data_situacao_especial',
] as const;

export const COLUNAS_EMPRESA = [
  'cnpj_basico', 'razao_social', 'natureza_juridica', 'qualificacao_responsavel', 'capital_social',
  'porte_empresa', 'ente_federativo_responsavel',
] as const;

export const COLUNAS_SIMPLES = [
  'cnpj_basico', 'opcao_simples', 'data_opcao_simples', 'data_exclusao_simples', 'opcao_mei',
  'data_opcao_mei', 'data_exclusao_mei',
] as const;

export const SITUACAO = { '01': 'NULA', '02': 'ATIVA', '03': 'SUSPENSA', '04': 'INAPTA', '08': 'BAIXADA' } as const;
export const PORTE = { '01': 'ME', '03': 'EPP', '05': 'DEMAIS' } as const;

type Linha<C extends readonly string[]> = Record<C[number], string>;

export function mapear<C extends readonly string[]>(colunas: C, valores: string[]): Linha<C> | null {
  if (valores.length < colunas.length) return null;
  const o = {} as Record<string, string>;
  colunas.forEach((c, i) => { o[c] = (valores[i] ?? '').trim(); });
  return o as Linha<C>;
}

/** "20150310" → "2015-03-10"; "0"/"00000000"/vazio → null */
export function dataReceita(v: string): string | null {
  if (!/^\d{8}$/.test(v) || v === '00000000') return null;
  const iso = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

export interface EstabelecimentoReceita {
  cnpj: string;
  cnpj_basico: string;
  matriz: boolean;
  nome_fantasia: string | null;
  situacao: string;
  data_inicio: string | null;
  cnae_principal: string;
  cnaes_secundarios: string[];
  logradouro: string | null;
  bairro: string | null;
  bairro_normalizado: string | null;
  cep: string | null;
  uf: string;
  municipio_codigo: string;
  telefones: string[];
  email: string | null;
}

export function converterEstabelecimento(l: Linha<typeof COLUNAS_ESTABELECIMENTO>): EstabelecimentoReceita {
  const tel = (ddd: string, n: string) => (ddd && n ? normalizarTelefone(`${ddd}${n}`) : null);
  const logradouro = [l.tipo_logradouro, l.logradouro, l.numero, l.complemento]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return {
    cnpj: `${l.cnpj_basico}${l.cnpj_ordem}${l.cnpj_dv}`.toUpperCase(),
    cnpj_basico: l.cnpj_basico,
    matriz: l.matriz_filial === '1',
    nome_fantasia: l.nome_fantasia || null,
    situacao: SITUACAO[l.situacao_cadastral as keyof typeof SITUACAO] ?? l.situacao_cadastral,
    data_inicio: dataReceita(l.data_inicio_atividades),
    cnae_principal: l.cnae_fiscal,
    cnaes_secundarios: l.cnae_fiscal_secundaria ? l.cnae_fiscal_secundaria.split(',').map((s) => s.trim()).filter(Boolean) : [],
    logradouro: logradouro || null,
    bairro: l.bairro || null,
    bairro_normalizado: l.bairro ? normalizarNome(l.bairro) : null,
    cep: /^\d{8}$/.test(l.cep) ? l.cep : null,
    uf: l.uf,
    municipio_codigo: l.municipio,
    telefones: [...new Set([tel(l.ddd1, l.telefone1), tel(l.ddd2, l.telefone2)].filter((t): t is string => !!t))],
    email: l.correio_eletronico ? l.correio_eletronico.toLowerCase() : null,
  };
}
