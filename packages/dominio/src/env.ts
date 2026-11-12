import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Carrega o .env da raiz do repositório (se existir). Variáveis já definidas no ambiente têm prioridade.
 * Os comandos rodam via `pnpm --filter`, com o diretório do pacote como cwd; por isso procura também ../../.env.
 */
export function carregarEnv(): string | null {
  for (const p of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (existsSync(p)) {
      process.loadEnvFile(p);
      return p;
    }
  }
  return null;
}
