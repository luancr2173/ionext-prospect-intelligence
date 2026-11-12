import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Os testes de integração da Central e do Motor compartilham o mesmo banco descartável
    // e truncam tabelas: os arquivos rodam em sequência.
    fileParallelism: false,
  },
});
