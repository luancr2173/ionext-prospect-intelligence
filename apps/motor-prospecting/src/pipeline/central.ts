import type { EmpresaCandidata, RespostaIngest } from '@ionext/contratos';
import { VERSAO_MOTOR } from '../config.ts';

export interface FiltrosBusca {
  uf: string;
  cidade: string;
  bairros: string[];
  segmento: string;
  cnaes: string[];
  portes: ('MEI' | 'ME' | 'EPP' | 'DEMAIS')[];
  quantidade_desejada: number;
}

/** Cliente HTTP da Central. O motor só fala com a Central por aqui (contratos v1). */
export class ClienteCentral {
  constructor(private base: string, private chave: string, private f: typeof fetch = fetch) {}

  private async req<T>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
    const res = await this.f(`${this.base}${caminho}`, {
      method: metodo,
      headers: { authorization: `Bearer ${this.chave}`, ...(corpo ? { 'content-type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const texto = await res.text();
    if (!res.ok) throw Object.assign(new Error(`Central ${metodo} ${caminho}: HTTP ${res.status} ${texto.slice(0, 500)}`), { status: res.status });
    return (texto ? JSON.parse(texto) : null) as T;
  }

  criarBusca(filtros: Partial<FiltrosBusca>) {
    return this.req<{ id: string }>('POST', '/v1/buscas', filtros);
  }
  obterBusca(id: string) {
    return this.req<{ id: string; filtros: FiltrosBusca; status: string }>('GET', `/v1/buscas/${id}`);
  }
  atualizarBusca(id: string, p: { status?: string; total_celulas?: number; concluidas?: number }) {
    return this.req('PATCH', `/v1/buscas/${id}`, p);
  }
  enviar(candidatas: EmpresaCandidata[], busca_id: string | null) {
    return this.req<RespostaIngest>('POST', '/v1/ingest/candidatas', { motor: VERSAO_MOTOR, busca_id, candidatas });
  }
}
