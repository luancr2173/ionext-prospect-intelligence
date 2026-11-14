/**
 * Google PageSpeed Insights v5 (gratuito). Sem chave a cota é pequena e compartilhada: 429 vira erro
 * temporário e a auditoria volta para a fila. Com PAGESPEED_API_KEY a cota é de dezenas de milhares por dia.
 */
import { lerPsi, type MetricasPsi } from '@ionext/dominio';

export class ErroTemporario extends Error {}

export type RodarPsi = (url: string, estrategia: 'mobile' | 'desktop') => Promise<MetricasPsi>;

export function psiReal(chave: string | null, timeoutMs = 120_000): RodarPsi {
  return async (url, estrategia) => {
    const q = new URLSearchParams({ url, strategy: estrategia, locale: 'pt_BR' });
    for (const c of ['performance', 'seo', 'accessibility', 'best-practices']) q.append('category', c);
    if (chave) q.set('key', chave);
    let res: Response;
    try {
      res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new ErroTemporario(`PageSpeed sem resposta (${(e as Error).name === 'TimeoutError' ? 'tempo esgotado' : (e as Error).message})`);
    }
    const corpo = await res.text();
    if (res.status === 429 || res.status >= 500) throw new ErroTemporario(`PageSpeed HTTP ${res.status}${res.status === 429 ? ' (cota)' : ''}`);
    if (!res.ok) {
      // 400 = o Google não conseguiu abrir a página (ex.: site fora do ar para ele): sem métricas, segue só com o HTML
      let msg = `HTTP ${res.status}`;
      try { msg = (JSON.parse(corpo) as { error?: { message?: string } }).error?.message?.slice(0, 200) ?? msg; } catch { /* corpo não-JSON */ }
      throw new Error(`PageSpeed: ${msg}`);
    }
    return lerPsi(JSON.parse(corpo), estrategia);
  };
}
