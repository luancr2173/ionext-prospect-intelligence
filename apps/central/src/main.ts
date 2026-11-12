import { criarApp } from './app.ts';
import { lerConfig } from './config.ts';
import { conectar } from './db.ts';

const cfg = lerConfig();
const sql = conectar(cfg.databaseUrl);
const app = criarApp(sql, cfg.apiKeys);

const parar = async () => {
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGINT', parar);
process.on('SIGTERM', parar);

await app.listen({ port: cfg.port, host: '0.0.0.0' });
