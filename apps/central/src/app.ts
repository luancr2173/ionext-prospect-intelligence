import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import type { Sql } from './db.ts';
import { rotasAuditorias } from './rotas/auditorias.ts';
import { rotasBuscas } from './rotas/buscas.ts';
import { rotasEmpresas } from './rotas/empresas.ts';
import { rotasIngest } from './rotas/ingest.ts';
import { rotasOptOut } from './rotas/optout.ts';
import { rotasPainel } from './rotas/painel.ts';
import { cookieSair, criarCookieSessao, senhaConfere, sessaoValida } from './sessao.ts';

const PASTA_PAINEL = join(dirname(fileURLToPath(import.meta.url)), '..', 'painel');
const ARQUIVOS_PAINEL: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'tema.js': 'text/javascript; charset=utf-8',
  'icone.svg': 'image/svg+xml',
};
const FONTES = new Set(['archivo-latin-standard-normal.woff2', 'instrument-serif-latin-400-italic.woff2', 'jetbrains-mono-latin-wght-normal.woff2']);

declare module 'fastify' {
  interface FastifyRequest { cliente: string }
}

function procurarChave(chaves: Map<string, string>, recebido: string): string | null {
  const a = Buffer.from(recebido);
  for (const [segredo, nome] of chaves) {
    const b = Buffer.from(segredo);
    if (a.length === b.length && timingSafeEqual(a, b)) return nome;
  }
  return null;
}

export interface OpcoesApp { logger?: boolean; painelSenha?: string | null; cookieSeguro?: boolean; trustProxy?: boolean }

/**
 * Freio contra adivinhação de senha: 5 erros em 15 min bloqueiam o IP por 15 min.
 * Em memória (um processo); atrás de proxy, use TRUST_PROXY=1 para ver o IP real.
 */
export function criarLimitadorLogin(maxErros = 5, janelaMs = 15 * 60_000) {
  const erros = new Map<string, { n: number; desde: number; bloqueadoAte: number }>();
  return {
    bloqueado(ip: string): number {
      const e = erros.get(ip);
      if (!e) return 0;
      if (e.bloqueadoAte > Date.now()) return Math.ceil((e.bloqueadoAte - Date.now()) / 60_000);
      if (Date.now() - e.desde > janelaMs) erros.delete(ip);
      return 0;
    },
    errou(ip: string) {
      const agora = Date.now();
      const e = erros.get(ip);
      const atual = e && agora - e.desde <= janelaMs ? e : { n: 0, desde: agora, bloqueadoAte: 0 };
      atual.n += 1;
      if (atual.n >= maxErros) atual.bloqueadoAte = agora + janelaMs;
      erros.set(ip, atual);
      if (erros.size > 10_000) erros.delete(erros.keys().next().value!); // não cresce sem limite
    },
    acertou(ip: string) { erros.delete(ip); },
  };
}

export function criarApp(sql: Sql, apiKeys: Map<string, string>, opts: OpcoesApp = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? true, bodyLimit: 5 * 1024 * 1024, trustProxy: !!opts.trustProxy });
  app.decorateRequest('cliente', '');
  const painelSenha = opts.painelSenha ?? null;

  // ---------------------------------------------------------------- painel (arquivos estáticos + login)
  const servir = async (arquivo: string, reply: import('fastify').FastifyReply) => {
    const tipo = ARQUIVOS_PAINEL[arquivo];
    if (!tipo) return reply.code(404).send({ erro: 'não encontrado' });
    const corpo = await readFile(join(PASTA_PAINEL, arquivo));
    return reply.header('content-type', tipo).header('cache-control', 'no-cache')
      .header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer')
      .header('strict-transport-security', opts.cookieSeguro ? 'max-age=31536000' : 'max-age=0')
      .header('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'")
      .send(corpo);
  };
  app.get('/', async (_req, reply) => servir('index.html', reply));
  app.get('/favicon.ico', async (_req, reply) => reply.redirect('/painel/icone.svg'));
  app.get('/painel/fontes/:arquivo', async (req, reply) => {
    const { arquivo } = req.params as { arquivo: string };
    if (!FONTES.has(arquivo)) return reply.code(404).send({ erro: 'não encontrado' });
    return reply.header('content-type', 'font/woff2').header('cache-control', 'public, max-age=31536000, immutable')
      .send(await readFile(join(PASTA_PAINEL, 'fontes', arquivo)));
  });
  app.get('/painel/:arquivo', async (req, reply) => servir((req.params as { arquivo: string }).arquivo, reply));
  app.get('/painel/sessao', async (req) => ({ habilitado: !!painelSenha, logado: sessaoValida(req.headers.cookie) }));
  const limitador = criarLimitadorLogin();
  app.post('/painel/login', async (req, reply) => {
    if (!painelSenha) return reply.code(503).send({ erro: 'painel desligado: defina PAINEL_SENHA no .env' });
    const minutos = limitador.bloqueado(req.ip);
    if (minutos) return reply.code(429).send({ erro: `Muitas tentativas. Tente de novo em ${minutos} min.` });
    const { senha } = (req.body ?? {}) as { senha?: string };
    if (typeof senha !== 'string' || !senhaConfere(senha, painelSenha)) {
      limitador.errou(req.ip);
      await new Promise((r) => setTimeout(r, 600)); // freia tentativa de adivinhar
      return reply.code(401).send({ erro: 'senha incorreta' });
    }
    limitador.acertou(req.ip);
    return reply.header('set-cookie', criarCookieSessao(!!opts.cookieSeguro)).send({ ok: true });
  });
  app.post('/painel/sair', async (_req, reply) => reply.header('set-cookie', cookieSair()).send({ ok: true }));

  app.get('/health', async () => {
    await sql`select 1`;
    return { ok: true };
  });

  app.addHook('onRequest', async (req, reply) => {
    const caminho = req.url.split('?')[0]!;
    if (caminho === '/health' || caminho === '/' || caminho === '/favicon.ico' || caminho.startsWith('/painel/')) return;
    const h = req.headers.authorization ?? '';
    const nome = h.startsWith('Bearer ') ? procurarChave(apiKeys, h.slice(7)) : null;
    if (nome) { req.cliente = nome; return; }
    // Painel: cookie de sessão; escritas exigem o cabeçalho x-painel (proteção extra contra CSRF)
    if (painelSenha && sessaoValida(req.headers.cookie) && (req.method === 'GET' || req.headers['x-painel'] === '1')) {
      req.cliente = 'painel';
      return;
    }
    return reply.code(401).send({ erro: 'não autorizado' });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ erro: 'contrato inválido', detalhes: err.issues });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ erro: status >= 500 ? 'erro interno' : (err as Error).message });
  });

  app.register(async (v1) => {
    rotasIngest(v1, sql);
    rotasEmpresas(v1, sql);
    rotasOptOut(v1, sql);
    rotasBuscas(v1, sql);
    rotasPainel(v1, sql);
    rotasAuditorias(v1, sql);
  }, { prefix: '/v1' });

  return app;
}
