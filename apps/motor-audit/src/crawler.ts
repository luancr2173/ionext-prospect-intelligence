/**
 * Leitura do site sem navegador: HTML da página inicial e de até N páginas internas, status dos links
 * internos, formulários, sitemap. Gera os SinaisSite que o domínio transforma em achados.
 */
import { parse, type HTMLElement } from 'node-html-parser';
import type { FormularioEncontrado, LinkChecado, SinaisSite } from '@ionext/dominio';

export interface RespostaPagina {
  status: number;
  urlFinal: string;
  corpo: string;
  contentType: string;
}

/** Porta de rede (injetada nos testes). Lança erro com `code` em falha de conexão/certificado. */
export interface Navegacao {
  get(url: string, opts?: { timeoutMs?: number; lerCorpo?: boolean }): Promise<RespostaPagina>;
}

const LIMITE_CORPO = 800_000;
const ERROS_CERTIFICADO = new Set([
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_NOT_YET_VALID', 'ERR_SSL_WRONG_VERSION_NUMBER',
]);
const WIDGETS_CHAT: [RegExp, string][] = [
  [/embed\.tawk\.to|tawk\.to\//i, 'Tawk.to'], [/jivosite|jivochat/i, 'JivoChat'], [/zopim|zdassets\.com|zendesk/i, 'Zendesk'],
  [/widget\.intercom\.io|intercomcdn/i, 'Intercom'], [/client\.crisp\.chat/i, 'Crisp'], [/code\.tidio\.co/i, 'Tidio'],
  [/manychat/i, 'ManyChat'], [/smartsupp/i, 'Smartsupp'], [/livechatinc\.com/i, 'LiveChat'], [/js\.usemessages\.com|hs-scripts/i, 'HubSpot'],
  [/octadesk/i, 'Octadesk'], [/blip\.ai|take\.net\/blip/i, 'Blip'], [/huggy\.(app|io)/i, 'Huggy'], [/zenvia/i, 'Zenvia'],
  [/callbell/i, 'Callbell'], [/chatwoot/i, 'Chatwoot'], [/kommo\.com|amocrm/i, 'Kommo'], [/botconversa/i, 'BotConversa'],
];
const EXTENSOES_ARQUIVO = /\.(pdf|jpe?g|png|gif|webp|svg|mp4|mp3|zip|rar|docx?|xlsx?|pptx?|ico|css|js|xml|txt)(\?|#|$)/i;

export function codigoErro(e: unknown): string {
  const err = e as { code?: string; cause?: { code?: string; message?: string }; name?: string; message?: string };
  return err?.cause?.code ?? err?.code ?? (err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'TIMEOUT' : err?.message ?? 'erro');
}

const textoErro = (codigo: string) => ({
  TIMEOUT: 'tempo esgotado', ENOTFOUND: 'domínio não encontrado', ECONNREFUSED: 'conexão recusada', ECONNRESET: 'conexão interrompida',
  EAI_AGAIN: 'falha de DNS', CERT_HAS_EXPIRED: 'certificado expirado', ERR_TLS_CERT_ALTNAME_INVALID: 'certificado de outro domínio',
}[codigo] ?? codigo);

export function navegacaoReal(userAgent: string): Navegacao {
  return {
    async get(url, opts) {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 15_000),
        headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'pt-BR,pt;q=0.9' },
      });
      let corpo = '';
      if (opts?.lerCorpo !== false && res.body) {
        const reader = res.body.getReader();
        const partes: Uint8Array[] = [];
        let total = 0;
        while (total < LIMITE_CORPO) {
          const { done, value } = await reader.read();
          if (done) break;
          partes.push(value); total += value.length;
        }
        await reader.cancel().catch(() => {});
        corpo = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(partes));
      } else {
        await res.body?.cancel().catch(() => {});
      }
      return { status: res.status, urlFinal: res.url || url, corpo, contentType: res.headers.get('content-type') ?? '' };
    },
  };
}

const hostSemWww = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

function resolver(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    u.hash = '';
    return u.toString();
  } catch { return null; }
}

interface Leitura {
  viewport: boolean; titulo: string | null; descricao: string | null; h1: number; gerador: string | null;
  whatsapp: string[]; telefones: string[]; internos: { url: string; texto: string }[];
  formularios: { action: string | null; metodo: string }[]; misto: string[]; anos: number[]; textoLen: number; scripts: number;
}

/** Lê o HTML de uma página (exportada para teste). */
export function lerHtml(html: string, urlPagina: string): Leitura {
  const raiz = parse(html, { lowerCaseTagName: true, comment: false, blockTextElements: { script: true, style: true, noscript: true } });
  const meta = (nome: string) => raiz.querySelector(`meta[name="${nome}"]`)?.getAttribute('content')?.trim() || null;
  const host = hostSemWww(urlPagina);
  const https = urlPagina.startsWith('https:');
  const whatsapp = new Set<string>(); const telefones = new Set<string>(); const internos = new Map<string, string>();
  for (const a of raiz.querySelectorAll('a[href]')) {
    const href = (a.getAttribute('href') ?? '').trim();
    if (/^(https?:)?\/\/(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com|chat\.whatsapp\.com)\b/i.test(href) || /^whatsapp:/i.test(href)) { whatsapp.add(href); continue; }
    if (/^tel:/i.test(href)) { telefones.add(href); continue; }
    if (!href || href.startsWith('#') || /^(mailto|javascript|sms|data):/i.test(href)) continue;
    const abs = resolver(href, urlPagina);
    if (!abs || !/^https?:/i.test(abs) || hostSemWww(abs) !== host || EXTENSOES_ARQUIVO.test(abs)) continue;
    if (!internos.has(abs)) internos.set(abs, (a.textContent || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80));
  }
  const formularios = raiz.querySelectorAll('form').map((f: HTMLElement) => ({
    action: f.getAttribute('action')?.trim() || null, metodo: (f.getAttribute('method') || 'get').toLowerCase(),
  }));
  const misto = https
    ? raiz.querySelectorAll('img[src], script[src], iframe[src], link[rel="stylesheet"][href], source[src], video[src], audio[src]')
      .map((el: HTMLElement) => (el.getAttribute('src') ?? el.getAttribute('href') ?? '').trim())
      .filter((u: string) => /^http:\/\//i.test(u))
    : [];
  const texto = raiz.querySelector('body')?.textContent?.replace(/\s+/g, ' ') ?? '';
  const anos: number[] = [];
  const reAno = /(?:©|&copy;|\(c\)|copyright|direitos reservados|todos os direitos)[^0-9]{0,40}((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?|((?:19|20)\d{2})\s*(?:©|&copy;)/gi;
  for (const m of `${texto} ${html.slice(-20_000)}`.matchAll(reAno)) {
    for (const g of [m[1], m[2], m[3]]) if (g) anos.push(Number(g));
  }
  return {
    viewport: !!raiz.querySelector('meta[name="viewport"]'),
    titulo: raiz.querySelector('title')?.textContent.replace(/\s+/g, ' ').trim() || null,
    descricao: meta('description'),
    h1: raiz.querySelectorAll('h1').length,
    gerador: meta('generator'),
    whatsapp: [...whatsapp], telefones: [...telefones],
    internos: [...internos.entries()].map(([url, t]) => ({ url, texto: t })),
    formularios, misto, anos: [...new Set(anos)], textoLen: texto.trim().length,
    scripts: raiz.querySelectorAll('script').length,
  };
}

const ehHtml = (r: RespostaPagina) => !r.contentType || /html/i.test(r.contentType);

export async function lerSite(nav: Navegacao, urlInformada: string, opts: { paginas?: number; links?: number; anoAtual?: number; pausaMs?: number } = {}): Promise<SinaisSite> {
  const maxPaginas = opts.paginas ?? 8;
  const maxLinks = opts.links ?? 20;
  const anoAtual = opts.anoAtual ?? new Date().getFullYear();
  const pausa = () => new Promise((r) => setTimeout(r, opts.pausaMs ?? 250));
  const base: SinaisSite = {
    url_inicial: urlInformada, url_final: null, respondeu: false, status_home: null, erro: null, https: false,
    certificado_ok: null, http_redireciona_https: null, viewport: false, titulo: null, descricao: null, h1: 0,
    whatsapp: [], telefones: [], formularios: [], links_internos: [], paginas: [], ano_rodape: null, conteudo_misto: [],
    sitemap: null, chat_widget: null, gerador: null, depende_js: false,
  };

  // 1. página inicial: tenta https primeiro (não penaliza site que tem https mas foi cadastrado como http)
  const u = new URL(urlInformada);
  const tentativas = u.protocol === 'http:' ? [`https://${u.host}${u.pathname}${u.search}`, urlInformada] : [urlInformada, `http://${u.host}${u.pathname}${u.search}`];
  let home: RespostaPagina | null = null;
  for (const t of tentativas) {
    try {
      home = await nav.get(t);
      break;
    } catch (e) {
      const c = codigoErro(e);
      if (t.startsWith('https:') && ERROS_CERTIFICADO.has(c)) base.certificado_ok = false;
      base.erro = textoErro(c);
    }
  }
  if (!home) return base;
  base.respondeu = true;
  base.erro = null;
  base.status_home = home.status;
  base.url_final = home.urlFinal;
  base.https = home.urlFinal.startsWith('https:');
  if (base.https && base.certificado_ok !== false) base.certificado_ok = true;
  base.paginas.push({ url: home.urlFinal, status: home.status });
  if (home.status >= 400 || !ehHtml(home)) return base;

  // 2. http → https?
  if (base.https) {
    try {
      const h = await nav.get(`http://${new URL(home.urlFinal).host}/`, { timeoutMs: 8_000, lerCorpo: false });
      base.http_redireciona_https = h.urlFinal.startsWith('https:');
    } catch { /* sem http: tudo bem */ }
  }

  const l0 = lerHtml(home.corpo, home.urlFinal);
  base.viewport = l0.viewport; base.titulo = l0.titulo; base.descricao = l0.descricao; base.h1 = l0.h1; base.gerador = l0.gerador;
  base.chat_widget = WIDGETS_CHAT.find(([re]) => re.test(home!.corpo))?.[1] ?? null;
  base.depende_js = l0.textoLen < 200 && l0.scripts >= 3;
  const whatsapp = new Set(l0.whatsapp); const telefones = new Set(l0.telefones); const misto = new Set(l0.misto); const anos = [...l0.anos];
  const forms: { pagina: string; action: string | null; metodo: string }[] = l0.formularios.map((f) => ({ pagina: home!.urlFinal, ...f }));
  const links = new Map<string, { texto: string; origem: string }>();
  l0.internos.forEach((l) => links.set(l.url, { texto: l.texto, origem: home!.urlFinal }));
  links.delete(home.urlFinal);

  // 3. páginas internas (as primeiras do menu) + checagem dos links
  const checados: LinkChecado[] = [];
  let paginasLidas = 0;
  for (const [url, info] of [...links.entries()].slice(0, maxLinks)) {
    await pausa();
    let status: number | null = null;
    try {
      const lerCorpo = paginasLidas < maxPaginas;
      const r = await nav.get(url, { timeoutMs: 10_000, lerCorpo });
      status = r.status;
      if (lerCorpo && r.status < 400 && ehHtml(r) && hostSemWww(r.urlFinal) === hostSemWww(home.urlFinal)) {
        paginasLidas++;
        base.paginas.push({ url: r.urlFinal, status: r.status });
        const l = lerHtml(r.corpo, r.urlFinal);
        l.whatsapp.forEach((x) => whatsapp.add(x)); l.telefones.forEach((x) => telefones.add(x)); l.misto.forEach((x) => misto.add(x));
        anos.push(...l.anos);
        l.formularios.forEach((f) => forms.push({ pagina: r.urlFinal, ...f }));
        if (!base.chat_widget) base.chat_widget = WIDGETS_CHAT.find(([re]) => re.test(r.corpo))?.[1] ?? null;
      }
    } catch { status = null; }
    checados.push({ url, status, pagina_origem: info.origem, texto: info.texto });
  }
  base.links_internos = checados;

  // 4. formulários: só checa o destino quando é do próprio site
  const vistos = new Set<string>();
  const formularios: FormularioEncontrado[] = [];
  for (const f of forms) {
    const destino = f.action ? resolver(f.action, f.pagina) : null;
    const chave = `${f.pagina}|${destino}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    let status: number | null | undefined;
    if (destino && /^https?:/i.test(destino) && hostSemWww(destino) === hostSemWww(home.urlFinal) && destino !== f.pagina) {
      try { status = (await nav.get(destino, { timeoutMs: 8_000, lerCorpo: false })).status; } catch { status = null; }
    }
    formularios.push({ pagina: f.pagina, action: f.action, metodo: f.metodo, status_destino: status });
    if (formularios.length >= 6) break;
  }
  base.formularios = formularios;

  // 5. sitemap
  try {
    const raizSite = new URL(home.urlFinal).origin;
    const sm = await nav.get(`${raizSite}/sitemap.xml`, { timeoutMs: 8_000 });
    base.sitemap = sm.status < 400 && /<(urlset|sitemapindex)\b/i.test(sm.corpo);
    if (!base.sitemap) {
      const rb = await nav.get(`${raizSite}/robots.txt`, { timeoutMs: 8_000 });
      if (rb.status < 400 && /^sitemap:/im.test(rb.corpo)) base.sitemap = true;
    }
  } catch { base.sitemap = null; }

  base.whatsapp = [...whatsapp]; base.telefones = [...telefones]; base.conteudo_misto = [...misto];
  const validos = anos.filter((a) => a >= 1995 && a <= anoAtual + 1);
  base.ano_rodape = validos.length ? Math.max(...validos) : null;
  return base;
}
