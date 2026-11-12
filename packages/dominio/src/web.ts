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
];

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
}

/**
 * O site encontrado é mesmo desta empresa? Precisa de prova:
 * CNPJ na página, OU telefone na página, OU todos os tokens do nome + cidade/bairro.
 */
export function confirmarTitularidade(html: string, d: DadosTitularidade): { confirmado: boolean; sinais: string[] } {
  const sinais: string[] = [];
  const soDigitos = html.replace(/\D/g, '');
  if (d.cnpj && /^\d{14}$/.test(d.cnpj) && soDigitos.includes(d.cnpj)) sinais.push('cnpj');
  for (const tel of d.telefones ?? []) {
    const local = tel.replace(/^\+55/, '');
    if (local.length >= 10 && soDigitos.includes(local.slice(2))) { sinais.push('telefone'); break; }
  }
  const texto = normalizarNome(html.replace(/<[^>]+>/g, ' '));
  const temNome = d.nomes.some((n) => {
    const tokens = normalizarNome(n).split(' ').filter((t) => t.length > 2);
    return tokens.length > 0 && tokens.every((t) => texto.includes(t));
  });
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
