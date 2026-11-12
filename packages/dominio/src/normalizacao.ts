/** Termos jurídicos e genéricos que não identificam a empresa. */
const RUIDO = new Set([
  'ltda', 'me', 'epp', 'eireli', 'sa', 's/a', 'mei', 'cia', 'e', 'de', 'da', 'do', 'das', 'dos',
]);

/** Nome em minúsculas, sem acento, sem pontuação e sem sufixos jurídicos. Usado na deduplicação. */
export function normalizarNome(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/s\/a/g, ' sa ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((p) => p && !RUIDO.has(p))
    .join(' ');
}

/**
 * Telefone brasileiro em E.164 (+55DDNNNNNNNN[N]). Retorna null se não parecer um número válido.
 * Não inventa DDD: sem DDD, o número é descartado.
 */
export function normalizarTelefone(bruto: string): string | null {
  let d = bruto.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.startsWith('0') && (d.length === 11 || d.length === 12)) d = d.slice(1);
  if (d.length !== 10 && d.length !== 11) return null;
  const ddd = Number(d.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  if (d.length === 11 && d[2] !== '9') return null;
  return `+55${d}`;
}

export function normalizarEmail(bruto: string): string | null {
  const e = bruto.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) ? e : null;
}

/** Domínios de e-mail gratuitos: não indicam site próprio. */
const PROVEDORES_GRATUITOS = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'live.com', 'yahoo.com', 'yahoo.com.br',
  'bol.com.br', 'uol.com.br', 'terra.com.br', 'icloud.com', 'ig.com.br', 'msn.com',
]);

/** Domínio próprio a partir do e-mail (V3), ou null se for provedor gratuito. */
export function dominioProprioDoEmail(email: string): string | null {
  const dominio = email.split('@')[1]?.toLowerCase();
  if (!dominio || PROVEDORES_GRATUITOS.has(dominio)) return null;
  return dominio;
}

export function normalizarCep(bruto: string): string | null {
  const d = bruto.replace(/\D/g, '');
  return d.length === 8 ? d : null;
}

/** Distância em metros (haversine). */
export function distanciaMetros(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
