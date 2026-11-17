import { carregarEnv } from '@ionext/dominio';
import { criarApp } from './app.ts';
import { lerConfig } from './config.ts';
import { conectar } from './db.ts';
import { recalcularAbertas } from './servicos/oportunidade.ts';

carregarEnv();
const cfg = lerConfig();
const sql = conectar(cfg.databaseUrl);
const app = criarApp(sql, cfg.apiKeys, {
  painelSenha: cfg.painelSenha,
  cookieSeguro: process.env.COOKIE_SEGURO === '1',
  trustProxy: process.env.TRUST_PROXY === '1', // atrás do proxy HTTPS da hospedagem
});

const parar = async () => {
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.on('SIGINT', parar);
process.on('SIGTERM', parar);

await app.listen({ port: cfg.port, host: cfg.host });
console.log(cfg.painelSenha
  ? `\n  Painel: http://localhost:${cfg.port}\n`
  : '\n  Painel desligado: defina PAINEL_SENHA no .env\n');

// regras do score mudam com o tempo (ex.: telefone do cadastro da Receita vale menos): atualiza as abertas
recalcularAbertas(sql)
  .then((r) => { if (r.total) console.log(`  Score atualizado em ${r.total - r.falhas} oportunidades abertas${r.falhas ? ` (${r.falhas} com erro)` : ''}.`); })
  .catch((e) => console.error('  Não deu para atualizar o score das oportunidades:', e instanceof Error ? e.message : e));
