import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Sessão do painel: cookie httpOnly assinado (HMAC) com validade. Sem dependências.
 * A chave de assinatura é aleatória por processo: reiniciar a Central desloga o painel.
 */
const CHAVE = randomBytes(32);
const NOME = 'pi_sessao';
const VALIDADE_MS = 12 * 3600 * 1000;

function assinar(valor: string): string {
  return createHmac('sha256', CHAVE).update(valor).digest('base64url');
}

export function criarCookieSessao(seguro: boolean): string {
  const exp = String(Date.now() + VALIDADE_MS);
  const token = `${exp}.${assinar(exp)}`;
  return `${NOME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${VALIDADE_MS / 1000}${seguro ? '; Secure' : ''}`;
}

export function cookieSair(): string {
  return `${NOME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function sessaoValida(cabecalhoCookie: string | undefined): boolean {
  if (!cabecalhoCookie) return false;
  const par = cabecalhoCookie.split(/;\s*/).find((c) => c.startsWith(`${NOME}=`));
  if (!par) return false;
  const [exp, assinatura] = par.slice(NOME.length + 1).split('.');
  if (!exp || !assinatura || Number(exp) < Date.now()) return false;
  const a = Buffer.from(assinatura);
  const b = Buffer.from(assinar(exp));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function senhaConfere(recebida: string, correta: string): boolean {
  const a = createHmac('sha256', CHAVE).update(recebida).digest();
  const b = createHmac('sha256', CHAVE).update(correta).digest();
  return timingSafeEqual(a, b);
}
