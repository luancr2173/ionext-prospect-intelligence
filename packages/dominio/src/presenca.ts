/**
 * Classificação de presença digital (Motor 01, seção 4.2 da arquitetura).
 * Regra de ouro: nunca SEM_SITE só porque uma fonte não mostrou site.
 */
export type Classificacao = 'SEM_SITE' | 'SOMENTE_REDES' | 'PRESENCA_FRACA' | 'SITE_EXISTENTE' | 'PENDENTE';
export type Confiabilidade = 'alta' | 'media' | 'baixa';

/** Resultado de cada verificação V1..V6. */
export type ResultadoVerificacao =
  | { status: 'nao_executado' }
  | { status: 'nao_aplicavel' }            // ex.: V3 sem e-mail com domínio próprio
  | { status: 'erro'; detalhe: string }    // timeout, cota, falha de rede
  | { status: 'inconclusivo'; url: string; detalhe: string } // site achado, titularidade não confirmada
  | { status: 'nada_encontrado' }
  | { status: 'site_encontrado'; url: string; acessivel: boolean };

export interface Verificacoes {
  V1: ResultadoVerificacao; // site em perfil verificado manualmente / FSQ OS
  V2: ResultadoVerificacao; // tag website no OSM
  V3: ResultadoVerificacao; // domínio do e-mail declarado
  V4: ResultadoVerificacao; // domínios candidatos pelo nome fantasia
  V5: ResultadoVerificacao; // busca web (opcional)
  V6: { status: 'nao_executado' } | { status: 'executado'; redes: string[] }; // redes/WhatsApp/linktree
}

export interface ResultadoClassificacao {
  classificacao: Classificacao;
  confiabilidade: Confiabilidade;
  url_site: string | null;
  motivos: string[];
}

const OBRIGATORIAS = ['V2', 'V3', 'V4'] as const;
const OPCIONAIS = ['V1', 'V5'] as const;

export function classificarPresenca(v: Verificacoes): ResultadoClassificacao {
  const todas = [...OPCIONAIS, ...OBRIGATORIAS] as const;

  // 1. Qualquer site encontrado decide, mesmo que outras verificações tenham falhado.
  const encontrados = todas
    .map((k) => [k, v[k]] as const)
    .filter((e): e is [typeof e[0], Extract<ResultadoVerificacao, { status: 'site_encontrado' }>] =>
      e[1].status === 'site_encontrado');

  const acessivel = encontrados.find(([, r]) => r.acessivel);
  if (acessivel) {
    return {
      classificacao: 'SITE_EXISTENTE',
      confiabilidade: 'alta',
      url_site: acessivel[1].url,
      motivos: [`${acessivel[0]}: site próprio acessível em ${acessivel[1].url}`],
    };
  }
  if (encontrados.length > 0) {
    const [k, r] = encontrados[0]!;
    return {
      classificacao: 'PRESENCA_FRACA',
      confiabilidade: 'alta',
      url_site: r.url,
      motivos: [`${k}: domínio ${r.url} encontrado, mas sem resposta`],
    };
  }

  // 2. Site candidato sem titularidade confirmada (em qualquer verificação) → revisão, nunca SEM_SITE.
  const inconclusivas = todas.filter((k) => v[k].status === 'inconclusivo');
  if (inconclusivas.length > 0) {
    const r = v[inconclusivas[0]!] as Extract<ResultadoVerificacao, { status: 'inconclusivo' }>;
    return {
      classificacao: 'PENDENTE',
      confiabilidade: 'baixa',
      url_site: null,
      motivos: [`${inconclusivas.join(', ')}: site candidato ${r.url} sem titularidade confirmada (${r.detalhe})`],
    };
  }

  // 3. Sem site encontrado: todas as obrigatórias precisam ter rodado de verdade.
  const pendentes = OBRIGATORIAS.filter((k) => v[k].status === 'nao_executado' || v[k].status === 'erro');
  if (pendentes.length > 0 || v.V6.status === 'nao_executado') {
    const faltando = [...pendentes, ...(v.V6.status === 'nao_executado' ? ['V6'] : [])];
    return {
      classificacao: 'PENDENTE',
      confiabilidade: 'baixa',
      url_site: null,
      motivos: [`verificações obrigatórias não concluídas: ${faltando.join(', ')}`],
    };
  }

  const opcionaisOk = OPCIONAIS.every((k) => v[k].status === 'nada_encontrado');
  const confiabilidade: Confiabilidade = opcionaisOk ? 'alta' : 'media';
  const executadas = todas.filter((k) => v[k].status === 'nada_encontrado');
  const base = `nenhum site próprio em ${executadas.join(', ')}`;

  if (v.V6.redes.length > 0) {
    return {
      classificacao: 'SOMENTE_REDES',
      confiabilidade,
      url_site: null,
      motivos: [base, `canais encontrados: ${v.V6.redes.join(', ')}`],
    };
  }
  return { classificacao: 'SEM_SITE', confiabilidade, url_site: null, motivos: [base, 'nenhuma rede social encontrada'] };
}
