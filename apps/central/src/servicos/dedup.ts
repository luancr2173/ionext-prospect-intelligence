import type { Db } from '../db.ts';

/**
 * Deduplicação (seção 6.2), em ordem de força:
 * 1. CNPJ igual → mesma empresa
 * 2. Identificador externo igual → mesma empresa
 * 3. Telefone igual + (distância < 300 m ou mesmo CEP) → mesma empresa
 *    Telefone igual sem confirmação de local → revisão manual
 * 4. Nome similar (trigram ≥ 0,7) + (mesmo CEP ou < 100 m) → revisão manual (nunca merge automático)
 */
export type ResultadoDedup =
  | { tipo: 'existente'; empresa_id: string; motivo: string }
  | { tipo: 'revisao'; empresa_id: string; similaridade: number; motivo: string }
  | { tipo: 'nova' };

export interface ChavesDedup {
  cnpj: string | null;
  identificadores: { fonte: string; valor: string }[];
  telefones: string[];
  nome_normalizado: string;
  cep: string | null;
  lat: number | null;
  lng: number | null;
}

export async function encontrarDuplicata(db: Db, c: ChavesDedup): Promise<ResultadoDedup> {
  if (c.cnpj) {
    const [r] = await db<{ id: string }[]>`select id from empresa where cnpj = ${c.cnpj}`;
    if (r) return { tipo: 'existente', empresa_id: r.id, motivo: 'cnpj' };
  }

  for (const idf of c.identificadores) {
    const [r] = await db<{ empresa_id: string }[]>`
      select empresa_id from identificador_externo where fonte = ${idf.fonte} and valor = ${idf.valor}`;
    if (r) return { tipo: 'existente', empresa_id: r.empresa_id, motivo: `identificador ${idf.fonte}` };
  }

  const ponto = db`extensions.st_setsrid(extensions.st_makepoint(${c.lng}::float8, ${c.lat}::float8), 4326)::extensions.geography`;

  if (c.telefones.length > 0) {
    const rows = await db<{ id: string; mesmo_local: boolean }[]>`
      select e.id,
             coalesce(extensions.st_dwithin(e.geo, ${ponto}, 300), false)
               or (e.cep is not null and e.cep = ${c.cep}::text) as mesmo_local
        from contato ct join empresa e on e.id = ct.empresa_id
       where ct.tipo in ('telefone', 'whatsapp') and ct.valor_normalizado = any(${c.telefones}::text[])
       order by mesmo_local desc
       limit 1`;
    const r = rows[0];
    if (r?.mesmo_local) return { tipo: 'existente', empresa_id: r.id, motivo: 'telefone + mesmo local' };
    if (r) return { tipo: 'revisao', empresa_id: r.id, similaridade: 1, motivo: 'mesmo telefone, local não confirmado' };
  }

  const [s] = await db<{ id: string; sim: number }[]>`
    select e.id, extensions.similarity(e.nome_normalizado, ${c.nome_normalizado}) as sim
      from empresa e
     where extensions.similarity(e.nome_normalizado, ${c.nome_normalizado}) >= 0.7
       and ((e.cep is not null and e.cep = ${c.cep}::text)
            or coalesce(extensions.st_dwithin(e.geo, ${ponto}, 100), false))
     order by sim desc
     limit 1`;
  if (s) return { tipo: 'revisao', empresa_id: s.id, similaridade: Number(s.sim), motivo: 'nome similar no mesmo local' };

  return { tipo: 'nova' };
}
