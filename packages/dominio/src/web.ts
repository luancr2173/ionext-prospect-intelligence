import { normalizarNome } from './normalizacao.ts';

/** Redes e canais que contam como "presença só em redes" (V6). */
const REDES: [RegExp, string][] = [
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$/, 'facebook'],
  [/^wa\.me$|(^|\.)whatsapp\.com$|^api\.whatsapp\.com$/, 'whatsapp'],
  [/(^|\.)linktr\.ee$|(^|\.)linkr\.bio$|(^|\.)beacons\.ai$|(^|\.)bio\.link$/, 'linktree'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)youtube\.com$/, 'youtube'],
];

/**
 * Diretórios, marketplaces e agregadores: aparecem na busca mas não são o site da empresa.
 * Também inclui construtores de "site" gratuitos que são só perfis (ex.: google business sites).
 */
const DIRETORIOS = [
  'google.com', 'goo.gl', 'g.page', 'maps.app.goo.gl', 'business.site',
  'guiamais.com.br', 'apontador.com.br', 'telelistas.net', 'solutudo.com.br', 'cylex.com.br',
  'cnpj.biz', 'casadosdados.com.br', 'econodata.com.br', 'cnpja.com', 'empresaqui.com.br', 'consultas.plus',
  'informecadastral.com.br', 'cnpj.services', 'monitorcnpj.com.br', 'cnpj.info', 'listamais.com.br',
  'doctoralia.com.br', 'boaconsulta.com', 'ifood.com.br', 'rappi.com.br', 'tripadvisor.com.br', 'tripadvisor.com',
  'yelp.com', 'foursquare.com', 'waze.com', 'reclameaqui.com.br', 'olx.com.br', 'mercadolivre.com.br',
  'zapimoveis.com.br', 'vivareal.com.br', 'imovelweb.com.br', 'webmotors.com.br', 'jusbrasil.com.br',
  'wikipedia.org', 'gympass.com', 'wellhub.com', 'totalpass.com.br', 'trinks.com', 'booksy.com', 'avec.app',
  // vistos na primeira busca real (consulta de CNPJ, guias, agregadores)
  'serasaexperian.com.br', 'agendarconsulta.com', 'cebes.com.br', 'dentalgold.com.br', 'dentmap.com.br',
  'leadhunterpro.app', 'licitario.com.br', 'negociosrio.com.br', 'srwatson.io', 'tavily.com', 'trustindex.io',
  'b2bseg.com.br', 'unisus.com.br', 'mundopsicologos.com', 'brazildentalrating.com', 'cnes.datasus.gov.br',
  'cnpj.ws', 'cnpjs.rocks', 'empresascnpj.com', 'consultacnpj.com', 'speedio.com.br', 'diretoriodeempresas.com.br',
];

/** Provedores de internet/e-mail: domínio do e-mail não indica site próprio. */
const PROVEDORES_EMAIL = [
  'brnet.com.br', 'globo.com', 'globomail.com', 'r7.com', 'oi.com.br', 'click21.com.br', 'superig.com.br',
  'zipmail.com.br', 'ibest.com.br', 'brturbo.com.br', 'veloxmail.com.br', 'hotmail.com.br', 'outlook.com.br',
  'yahoo.com', 'ymail.com', 'gmx.com', 'me.com', 'protonmail.com', 'proton.me', 'aol.com', 'zoho.com',
  'terra.com.br', 'uol.com.br', 'bol.com.br', 'ig.com.br', 'gmail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'msn.com', 'yahoo.com.br', 'net.com.br', 'netsite.com.br', 'correioweb.com.br', 'unb.br',
];

export function ehProvedorEmail(dominio: string): boolean {
  const d = dominio.toLowerCase();
  return PROVEDORES_EMAIL.some((p) => d === p || d.endsWith(`.${p}`));
}

/** Palavras que aparecem no nome de qualquer empresa do ramo e não identificam ninguém. */
const GENERICAS = new Set([
  'clinica', 'clinicas', 'odontologia', 'odontologica', 'odontologico', 'odonto', 'dental', 'dentaria', 'dentario',
  'dentista', 'dentistas', 'integrada', 'integrado', 'centro', 'instituto', 'saude', 'oral', 'bucal', 'consultorio',
  'medica', 'medico', 'medicina', 'servicos', 'servico', 'associados', 'sociedade', 'simples', 'brasil', 'brasilia',
  'especializada', 'especializado', 'reabilitacao', 'estetica', 'ortodontia', 'implantes', 'grupo', 'unidade',
  'academia', 'restaurante', 'lanchonete', 'barbearia', 'salao', 'beleza', 'auto', 'oficina', 'mecanica',
  'construtora', 'construcoes', 'engenharia', 'imoveis', 'imobiliaria', 'contabilidade', 'contabil', 'assessoria',
  'comercio', 'empresa', 'cia', 'filial', 'matriz', 'dr', 'dra', 'ss',
  'odontopediatria', 'endodontia', 'implantodontia', 'periodontia', 'protese', 'radiologia', 'radiologica',
  'center', 'clinic', 'clin', 'odontologicos', 'odontologicas', 'especialidades', 'avancada', 'avancado',
]);

/** Sufixos que aparecem colados a uma sigla no domínio/@: "jc"+"dental", "cob"+"odontologia"+"brasilia". */
const COMPLEMENTOS = [...GENERICAS, 'bsb', 'df', 'brasilia', 'odonto', 'dent', 'clin', 'oficial', 'br'];

/** Termos do nome que realmente identificam a empresa (sem genéricos, sem sufixo jurídico, ≥ 3 letras). */
export function tokensDistintivos(nomes: string[], extras: string[] = []): string[] {
  const gen = new Set([...GENERICAS, ...extras.map((e) => normalizarNome(e))]);
  const out = new Set<string>();
  for (const n of nomes) {
    for (const t of normalizarNome(n).split(' ')) if (t.length >= 3 && !gen.has(t) && !/^\d+$/.test(t)) out.add(t);
  }
  return [...out];
}

const SUFIXOS_TLD = ['.com.br', '.net.br', '.org.br', '.odo.br', '.med.br', '.adv.br', '.eng.br', '.arq.br', '.com', '.net', '.org', '.br', '.io', '.app', '.site', '.online'];

/** "www.estheticalodontologia.com.br" → "estheticalodontologia" */
export function rotuloDominio(host: string): string {
  let h = host.toLowerCase().replace(/^www\./, '');
  for (const s of SUFIXOS_TLD) if (h.endsWith(s)) { h = h.slice(0, -s.length); break; }
  return (h.split('.').pop() ?? h).replace(/-/g, '');
}

/** Siglas do nome (2–3 letras, não genéricas): "Clínica Odontológica JC" → ["jc"]. */
export function siglas(nomes: string[], extras: string[] = []): string[] {
  const gen = new Set([...GENERICAS, ...extras.map((e) => normalizarNome(e))]);
  const out = new Set<string>();
  for (const n of nomes) for (const t of normalizarNome(n).split(' ')) if (/^[a-z]{2,3}$/.test(t) && !gen.has(t)) out.add(t);
  return [...out];
}

/** "odontologiabrasilia" é só complemento genérico? (consome palavras conhecidas do início ao fim) */
function soComplemento(resto: string): boolean {
  if (resto === '') return true;
  return COMPLEMENTOS.some((c) => c.length > 0 && resto.startsWith(c) && soComplemento(resto.slice(c.length)));
}

/** Rótulo (domínio ou @) bate com a sigla + complemento genérico: "jcdental", "csodonto", "cobodontologia". */
function combinaSigla(rotulo: string, nomes: string[], extras: string[]): boolean {
  return siglas(nomes, extras).some((sg) => rotulo.startsWith(sg) && soComplemento(rotulo.slice(sg.length)));
}

/** O domínio tem a "cara" da empresa? Termo distintivo do nome no rótulo do domínio, ou sigla + complemento genérico. */
export function dominioCombinaComNome(host: string, nomes: string[], extras: string[] = []): boolean {
  const rotulo = rotuloDominio(host);
  // O termo precisa estar "inteiro": no início, no fim, ou colado só a palavras genéricas
  // (evita "inodonto" casar com "orthocl-inodonto-logia")
  const naBorda = (t: string) => {
    let i = rotulo.indexOf(t);
    while (i >= 0) {
      const antes = rotulo.slice(0, i);
      const depois = rotulo.slice(i + t.length);
      if (antes === '' || depois === '' || soComplemento(antes) || soComplemento(depois)) return true;
      i = rotulo.indexOf(t, i + 1);
    }
    return false;
  };
  const porTermo = tokensDistintivos(nomes, extras).some((t) => t.length >= 4 ? naBorda(t) : rotulo.startsWith(t) || rotulo.endsWith(t));
  return porTermo || combinaSigla(rotulo, nomes, extras);
}

const NAO_PERFIL = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'share', 'watch', 'groups', 'events', 'hashtag', 'search']);

/**
 * Um resultado de rede social é o perfil DESTA empresa?
 * - descarta posts/reels soltos (não são perfil);
 * - aceita se todos os termos distintivos do nome estão no @ (ex.: studiosetti.odonto) ou no título do resultado,
 *   ou se o @ é sigla + complemento (cob.odontologia). Nome só genérico → exige título muito parecido.
 */
export function perfilCombinaComNome(url: string, titulo: string, nomes: string[], extras: string[] = []): boolean {
  let handle: string;
  try {
    const partes = new URL(url).pathname.split('/').filter(Boolean);
    if (partes.length === 0 || NAO_PERFIL.has(partes[0]!.toLowerCase())) return false;
    handle = partes[0]!.toLowerCase().replace(/^@/, '').replace(/[._-]/g, '');
  } catch { return false; }
  const tituloNorm = ` ${normalizarNome(titulo)} `;
  // Cada nome (fantasia, razão social) é avaliado sozinho: basta um bater
  return nomes.some((nome) => {
    const distintivos = tokensDistintivos([nome], extras);
    if (distintivos.length > 0) {
      if (distintivos.every((t) => handle.includes(t))) return true;
      if (distintivos.every((t) => tituloNorm.includes(` ${t} `))) return true;
    }
    if (combinaSigla(handle, [nome], extras)) return true;
    const sg = siglas([nome], extras);
    if (sg.length > 0 && sg.every((x) => tituloNorm.includes(` ${x} `))) return true;
    return distintivos.length === 0 && sg.length === 0 && similaridadeNomes(nome, titulo) >= 0.8;
  });
}

/** Página "rasa" (home ou 1 nível, sem IDs/CNPJ no caminho) — páginas de diretório costumam ser profundas e com ID. */
export function paginaRasa(url: string): boolean {
  try {
    const u = new URL(url);
    const partes = u.pathname.split('/').filter(Boolean);
    return partes.length <= 1 && !/\d{5,}/.test(u.pathname) && !u.search.includes('id=');
  } catch { return false; }
}

export type TipoUrl = { tipo: 'rede'; rede: string } | { tipo: 'diretorio' } | { tipo: 'candidato_site' } | { tipo: 'invalida' };

export function hostDe(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function classificarUrl(url: string): TipoUrl {
  const host = hostDe(url);
  if (!host) return { tipo: 'invalida' };
  for (const [re, rede] of REDES) if (re.test(host)) return { tipo: 'rede', rede };
  if (DIRETORIOS.some((d) => host === d || host.endsWith(`.${d}`))) return { tipo: 'diretorio' };
  if (host.endsWith('.gov.br') || host.endsWith('.jus.br')) return { tipo: 'diretorio' };
  return { tipo: 'candidato_site' };
}

/**
 * Domínios candidatos a partir do nome (V4). Poucos e prováveis, para não martelar DNS.
 * Ex.: "Clínica Sorriso Feliz" → sorrisofeliz.com.br, clinicasorrisofeliz.com.br, sorrisofeliz.com ...
 */
export function dominiosCandidatos(nomes: string[], palavrasSegmento: string[] = [], max = 6): string[] {
  const out: string[] = [];
  const add = (slug: string) => {
    if (slug.length < 4 || slug.length > 40) return;
    for (const tld of ['.com.br', '.com']) {
      const d = slug + tld;
      if (!out.includes(d)) out.push(d);
    }
  };
  const genericas = new Set(palavrasSegmento.map((p) => normalizarNome(p)));
  for (const nome of nomes) {
    const tokens = normalizarNome(nome).split(' ').filter(Boolean);
    if (tokens.length === 0) continue;
    const semGenericas = tokens.filter((t) => !genericas.has(t));
    if (semGenericas.length > 0) add(semGenericas.join(''));
    add(tokens.join(''));
    if (semGenericas.length > 1) add(semGenericas.join('-'));
  }
  return out.slice(0, max);
}

const SINAIS_PARKING = [
  'this domain is for sale', 'este domínio está à venda', 'domain is parked', 'domínio estacionado',
  'buy this domain', 'compre este domínio', 'parkingcrew', 'sedoparking', 'hugedomains', 'dan.com',
  'site em construção', 'em construção', 'coming soon', 'index of /', 'default web site page',
  'hostgator', 'apache2 ubuntu default page', 'welcome to nginx', 'plesk', 'cpanel',
];

/** Página genérica de hospedagem/estacionamento? (não conta como site funcional) */
export function pareceParking(html: string): boolean {
  const t = html.toLowerCase();
  const texto = t.replace(/<[^>]+>/g, ' ');
  if (texto.replace(/\s+/g, ' ').trim().length < 200 && !/<a\s/i.test(html)) return true;
  return SINAIS_PARKING.some((s) => t.includes(s));
}

export interface DadosTitularidade {
  cnpj?: string | null;
  telefones?: string[];   // E.164
  nomes: string[];
  cidade?: string | null;
  bairro?: string | null;
  /** Palavras genéricas do segmento (ex.: "odonto"), além da lista global */
  genericas?: string[];
}

/**
 * O conteúdo da página tem prova de que é desta empresa?
 * CNPJ, OU telefone completo (DDD + número), OU todos os termos DISTINTIVOS do nome + cidade/bairro.
 * Atenção: diretórios também mostram CNPJ/telefone. Quem decide se a página é o SITE da empresa é
 * `avaliarSitePara` (domínio compatível ou página rasa), não esta função sozinha.
 */
export function confirmarTitularidade(html: string, d: DadosTitularidade): { confirmado: boolean; sinais: string[] } {
  const sinais: string[] = [];
  const soDigitos = html.replace(/\D/g, '');
  if (d.cnpj && /^\d{14}$/.test(d.cnpj) && soDigitos.includes(d.cnpj)) sinais.push('cnpj');
  for (const tel of d.telefones ?? []) {
    // DDD + número completos (evita coincidência de 8 dígitos soltos numa página cheia de números)
    const local = tel.replace(/^\+55/, '');
    if (local.length >= 10 && soDigitos.includes(local)) { sinais.push('telefone'); break; }
  }
  const texto = ` ${normalizarNome(html.replace(/<[^>]+>/g, ' '))} `;
  // Só termos distintivos: "Clínica Odontológica Integrada" não confirma nada (qualquer dentista tem isso na página)
  const temNome = nomeApareceNoTexto(texto, d.nomes, d.genericas ?? []);
  const temLocal = [d.cidade, d.bairro].some((l) => l && texto.includes(normalizarNome(l)));
  if (temNome && temLocal) sinais.push('nome+local');
  return { confirmado: sinais.length > 0, sinais };
}

/** Similaridade de nomes por tokens (Dice), 0..1. Usada para casar Receita × OSM. */
export function similaridadeNomes(a: string, b: string): number {
  const ta = new Set(normalizarNome(a).split(' ').filter((t) => t.length > 1));
  const tb = new Set(normalizarNome(b).split(' ').filter((t) => t.length > 1));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/** Algum dos nomes (fantasia OU razão social) aparece inteiro no texto (só termos distintivos)? */
function nomeApareceNoTexto(textoNormalizado: string, nomes: string[], extras: string[]): boolean {
  return nomes.some((n) => {
    const d = tokensDistintivos([n], extras);
    return d.length > 0 && d.every((t) => textoNormalizado.includes(` ${t} `));
  });
}

export type OrigemSite = 'osm' | 'email' | 'nome' | 'busca';
export type VeredictoSite = { tipo: 'proprio'; sinais: string[] } | { tipo: 'fraco'; detalhe: string } | { tipo: 'terceiro'; detalhe: string };

/**
 * Decide se uma página ATIVA é o site próprio da empresa, conforme a origem do link:
 * - osm: website declarado no POI casado → próprio.
 * - email: domínio do e-mail declarado na Receita → próprio se o domínio combina com o nome, ou se a home tem CNPJ/telefone.
 * - nome/busca: precisa de domínio compatível com o nome + prova no conteúdo; OU página rasa com CNPJ/telefone.
 *   Páginas profundas em domínio que não é da empresa (diretórios, consultas de CNPJ) → terceiro, mesmo com telefone.
 */
export function avaliarSitePara(url: string, html: string, d: DadosTitularidade, origem: OrigemSite): VeredictoSite {
  const host = hostDe(url) ?? '';
  if (classificarUrl(url).tipo === 'diretorio') return { tipo: 'terceiro', detalhe: 'diretório/agregador conhecido' };
  if (origem === 'osm') return { tipo: 'proprio', sinais: ['website do POI no OSM'] };

  const t = confirmarTitularidade(html, d);
  const forte = t.sinais.includes('cnpj') || t.sinais.includes('telefone');
  const combina = dominioCombinaComNome(host, d.nomes, d.genericas ?? []);
  const raso = paginaRasa(url);

  if (origem === 'email') {
    if (ehProvedorEmail(host)) return { tipo: 'terceiro', detalhe: 'provedor de e-mail' };
    if (combina) return { tipo: 'proprio', sinais: ['domínio do e-mail declarado combina com o nome', ...t.sinais] };
    if (raso && forte) return { tipo: 'proprio', sinais: ['domínio do e-mail declarado', ...t.sinais] };
    return { tipo: 'terceiro', detalhe: 'domínio do e-mail sem relação com o nome e sem CNPJ/telefone na página' };
  }

  if (combina && t.confirmado) return { tipo: 'proprio', sinais: ['domínio combina com o nome', ...t.sinais] };
  if (!combina && raso && forte) return { tipo: 'proprio', sinais: ['home com CNPJ/telefone da empresa', ...t.sinais] };
  const texto = ` ${normalizarNome(html.replace(/<[^>]+>/g, ' '))} `;
  const nomeAparece = nomeApareceNoTexto(texto, d.nomes, d.genericas ?? []);
  if (combina && nomeAparece) return { tipo: 'fraco', detalhe: 'domínio e nome compatíveis, sem CNPJ/telefone/endereço na página' };
  // Achado pela busca com o nome da empresa e domínio com a cara dela: na dúvida, revisão humana (nunca "sem site")
  if (combina && origem === 'busca') return { tipo: 'fraco', detalhe: 'domínio parecido com o nome, achado na busca; conferir' };
  return { tipo: 'terceiro', detalhe: raso ? 'site sem relação comprovada' : 'página de terceiro (diretório/listagem)' };
}
