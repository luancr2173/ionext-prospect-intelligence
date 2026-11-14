import type { DiagnosticoSite } from '@ionext/contratos';

export interface ItemFila { empresa_id: string; url: string; tentativas: number; motivo: string; nome_fantasia: string }

export class ClienteCentral {
  constructor(private url: string, private chave: string) {}

  private async req<T>(metodo: string, caminho: string, corpo?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${caminho}`, {
      method: metodo,
      headers: { authorization: `Bearer ${this.chave}`, ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const texto = await res.text();
    if (!res.ok) throw Object.assign(new Error(`Central ${metodo} ${caminho}: HTTP ${res.status} ${texto.slice(0, 300)}`), { status: res.status });
    return (texto ? JSON.parse(texto) : null) as T;
  }

  reservar(limite: number) { return this.req<{ itens: ItemFila[]; na_fila: number }>('POST', '/v1/auditorias/reservar', { limite }); }
  enviar(d: DiagnosticoSite) { return this.req<{ classe: string; oportunidade: string | null; lead_score: number | null }>('POST', '/v1/auditorias', d); }
  falhou(empresaId: string, erro: string) { return this.req('POST', `/v1/auditorias/${empresaId}/falha`, { erro: erro.slice(0, 500) }); }
  status(dados: Record<string, unknown>) { return this.req('PUT', '/v1/motores/motor-audit', dados); }
}
