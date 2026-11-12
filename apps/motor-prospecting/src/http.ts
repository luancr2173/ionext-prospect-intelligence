import { promises as dns } from 'node:dns';

export interface RespostaHttp {
  status: number;
  urlFinal: string;
  corpo: string;
  contentType: string;
}

/** Portas de I/O do motor. Injetadas para poder testar sem rede. */
export interface Rede {
  get(url: string, opts?: { timeoutMs?: number }): Promise<RespostaHttp>;
  postJson(url: string, corpo: unknown, headers: Record<string, string>, opts?: { timeoutMs?: number }): Promise<{ status: number; json: unknown }>;
  /** Resolve A/AAAA. `null` = domínio não existe/sem registro de endereço. Lança em erro transitório. */
  resolver(host: string): Promise<string[] | null>;
}

const LIMITE_CORPO = 600_000;

async function lerCorpo(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const partes: Uint8Array[] = [];
  let total = 0;
  while (total < LIMITE_CORPO) {
    const { done, value } = await reader.read();
    if (done) break;
    partes.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(partes));
}

export function redeReal(userAgent: string): Rede {
  return {
    async get(url, opts) {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 12_000),
        headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'pt-BR,pt;q=0.9' },
      });
      return { status: res.status, urlFinal: res.url, corpo: await lerCorpo(res), contentType: res.headers.get('content-type') ?? '' };
    },
    async postJson(url, corpo, headers, opts) {
      const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 30_000),
        headers: { 'content-type': 'application/json', 'user-agent': userAgent, ...headers },
        body: JSON.stringify(corpo),
      });
      const texto = await res.text();
      let json: unknown = null;
      try { json = JSON.parse(texto); } catch { json = { texto }; }
      return { status: res.status, json };
    },
    async resolver(host) {
      const tentar = async (fn: () => Promise<string[]>) => {
        try { return await fn(); } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          // Domínio inexistente ou sem registro A/AAAA: resposta definitiva. Timeout/SERVFAIL: transitório.
          if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
          throw e;
        }
      };
      const [v4, v6] = await Promise.all([tentar(() => dns.resolve4(host)), tentar(() => dns.resolve6(host))]);
      const todos = [...v4, ...v6];
      return todos.length ? todos : null;
    },
  };
}
