export interface Config {
  databaseUrl: string;
  port: number;
  /** segredo → nome do cliente (motor-prospecting, neo-n8n, ...) */
  apiKeys: Map<string, string>;
}

export function lerConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL não definida');

  const apiKeys = new Map<string, string>();
  for (const par of (env.CENTRAL_API_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = par.indexOf(':');
    const nome = par.slice(0, i);
    const segredo = par.slice(i + 1);
    if (i < 1 || segredo.length < 32 || segredo === 'TROQUE') {
      throw new Error(`CENTRAL_API_KEYS: entrada inválida para "${nome || par}" (formato nome:segredo, segredo ≥ 32 caracteres)`);
    }
    apiKeys.set(segredo, nome);
  }
  if (apiKeys.size === 0) throw new Error('CENTRAL_API_KEYS vazia: a API não sobe sem autenticação');

  return { databaseUrl, port: Number(env.PORT ?? 3333), apiKeys };
}
