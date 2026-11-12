import { normalizarCep, normalizarNome, normalizarTelefone, similaridadeNomes, type Segmento } from '@ionext/dominio';
import type { Sql } from '../db.ts';
import type { Rede } from '../http.ts';

const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

export interface PoiOsm {
  osm_id: string;
  nome: string;
  tags: Record<string, string>;
  lat: number | null;
  lng: number | null;
}

/**
 * Atualiza o catálogo de POIs do segmento na UF (uma consulta Overpass por segmento, no máximo a cada 7 dias).
 * Uso responsável da API pública do Overpass: nada de consulta por empresa.
 */
export async function atualizarCatalogoOsm(sql: Sql, rede: Rede, uf: string, seg: Segmento, forcar = false): Promise<number> {
  const [r] = await sql<{ recente: boolean }[]>`
    select coalesce(max(atualizado_em) > now() - interval '7 days', false) as recente
      from motor.catalogo_osm_atualizacao where uf = ${uf} and segmento = ${seg.id}`;
  if (r?.recente && !forcar) return -1;

  const filtros = seg.osm.map((f) => {
    const [k, v] = f.split('=');
    return `nwr["${k}"="${v}"](area.a);`;
  }).join('\n  ');
  const consulta = `[out:json][timeout:180];
area["ISO3166-2"="BR-${uf}"]["admin_level"="4"]->.a;
(
  ${filtros}
);
out center tags;`;

  // A API do Overpass aceita a consulta via GET ?data=
  const res = await rede.get(`${OVERPASS}?data=${encodeURIComponent(consulta)}`, { timeoutMs: 200_000 });
  if (res.status !== 200) throw new Error(`Overpass HTTP ${res.status}`);
  const json = JSON.parse(res.corpo) as { elements: { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] };

  const pois = json.elements
    .filter((e) => e.tags?.name)
    .map((e) => ({
      osm_id: `${e.type}/${e.id}`, uf, segmento: seg.id, nome: e.tags!.name!, nome_normalizado: normalizarNome(e.tags!.name!),
      tags: e.tags!, lat: e.lat ?? e.center?.lat ?? null, lng: e.lon ?? e.center?.lon ?? null,
    }));

  await sql.begin(async (tx) => {
    await tx`delete from motor.catalogo_osm where uf = ${uf} and segmento = ${seg.id}`;
    for (let i = 0; i < pois.length; i += 500) {
      const lote = pois.slice(i, i + 500).map((p) => ({ ...p, tags: tx.json(p.tags as never) }));
      await tx`insert into motor.catalogo_osm ${tx(lote)} on conflict do nothing`;
    }
    await tx`insert into motor.catalogo_osm_atualizacao (uf, segmento, total) values (${uf}, ${seg.id}, ${pois.length})
             on conflict (uf, segmento) do update set total = excluded.total, atualizado_em = now()`;
  });
  return pois.length;
}

export interface CasamentoOsm { poi: PoiOsm; motivo: string; similaridade: number }

function telefonesDoPoi(tags: Record<string, string>): string[] {
  return ['phone', 'contact:phone', 'contact:mobile', 'contact:whatsapp']
    .flatMap((k) => (tags[k] ?? '').split(/[;,]/))
    .map((t) => normalizarTelefone(t))
    .filter((t): t is string => !!t);
}

/**
 * Casa um estabelecimento da Receita com um POI do catálogo:
 * telefone igual; ou nome muito parecido (≥ 0,9); ou nome parecido (≥ 0,75) + mesmo CEP/bairro.
 */
export function casarComCatalogo(
  catalogo: PoiOsm[],
  e: { nomes: string[]; telefones: string[]; cep: string | null; bairro: string | null },
): CasamentoOsm | null {
  let melhor: CasamentoOsm | null = null;
  const bairro = e.bairro ? normalizarNome(e.bairro) : null;
  for (const poi of catalogo) {
    if (telefonesDoPoi(poi.tags).some((t) => e.telefones.includes(t))) {
      return { poi, motivo: 'telefone', similaridade: 1 };
    }
    const sim = Math.max(...e.nomes.map((n) => similaridadeNomes(n, poi.nome)));
    const cepPoi = poi.tags['addr:postcode'] ? normalizarCep(poi.tags['addr:postcode']) : null;
    const bairroPoi = poi.tags['addr:suburb'] ?? poi.tags['addr:neighbourhood'] ?? poi.tags['addr:district'];
    const mesmoLocal = (!!e.cep && cepPoi === e.cep) || (!!bairro && !!bairroPoi && normalizarNome(bairroPoi) === bairro);
    const ok = sim >= 0.9 || (sim >= 0.75 && mesmoLocal);
    if (ok && (!melhor || sim > melhor.similaridade)) {
      melhor = { poi, motivo: sim >= 0.9 ? 'nome' : 'nome + local', similaridade: sim };
    }
  }
  return melhor;
}

/** Catálogo do segmento, ou null se nunca foi carregado com sucesso (V2 vira erro → PENDENTE). */
export async function carregarCatalogo(sql: Sql, uf: string, segmento: string): Promise<PoiOsm[] | null> {
  const [atual] = await sql`select 1 from motor.catalogo_osm_atualizacao where uf = ${uf} and segmento = ${segmento}`;
  if (!atual) return null;
  return sql<PoiOsm[]>`select osm_id, nome, tags, lat, lng from motor.catalogo_osm where uf = ${uf} and segmento = ${segmento}`;
}

/** Website e redes declarados no POI. */
export function canaisDoPoi(tags: Record<string, string>): { website: string | null; redes: { rede: string; url: string }[]; telefones: string[]; whatsapp: string[] } {
  const website = tags.website ?? tags['contact:website'] ?? tags.url ?? null;
  const redes: { rede: string; url: string }[] = [];
  const ig = tags['contact:instagram'];
  if (ig) redes.push({ rede: 'instagram', url: ig.startsWith('http') ? ig : `https://instagram.com/${ig.replace(/^@/, '')}` });
  const fb = tags['contact:facebook'];
  if (fb) redes.push({ rede: 'facebook', url: fb.startsWith('http') ? fb : `https://facebook.com/${fb}` });
  const whatsapp = (tags['contact:whatsapp'] ?? '').split(/[;,]/).map((t) => normalizarTelefone(t)).filter((t): t is string => !!t);
  const telefones = ['phone', 'contact:phone', 'contact:mobile'].flatMap((k) => (tags[k] ?? '').split(/[;,]/))
    .map((t) => normalizarTelefone(t)).filter((t): t is string => !!t);
  return { website: website && /^https?:\/\//.test(website) ? website : website ? `http://${website}` : null, redes, telefones, whatsapp };
}
