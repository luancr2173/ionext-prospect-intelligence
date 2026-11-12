/**
 * CNPJ numérico e alfanumérico (Receita Federal, emissão alfanumérica desde 31/07/2026).
 * 14 caracteres: 12 alfanuméricos [0-9A-Z] + 2 dígitos verificadores numéricos.
 * DV: módulo 11 sobre o valor (código ASCII − 48) de cada caractere — idêntico ao método
 * numérico antigo quando só há dígitos.
 */
const PESOS_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_DV2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function digito(base: string, pesos: number[]): number {
  let soma = 0;
  for (let i = 0; i < base.length; i++) soma += (base.charCodeAt(i) - 48) * pesos[i]!;
  const r = soma % 11;
  return r < 2 ? 0 : 11 - r;
}

/** Remove máscara e coloca em maiúsculas. Não valida. */
export function limparCnpj(bruto: string): string {
  return bruto.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function cnpjValido(bruto: string): boolean {
  const c = limparCnpj(bruto);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c)) return false;
  if (/^(\d)\1{13}$/.test(c)) return false;
  const dv1 = digito(c.slice(0, 12), PESOS_DV1);
  const dv2 = digito(c.slice(0, 12) + dv1, PESOS_DV2);
  return c.endsWith(`${dv1}${dv2}`);
}
