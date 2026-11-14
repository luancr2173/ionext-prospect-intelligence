import { describe, expect, it } from 'vitest';
import { auditar } from '../src/auditar.ts';
import { lerHtml, lerSite, type Navegacao, type RespostaPagina } from '../src/crawler.ts';
import { ErroTemporario } from '../src/psi.ts';

const HOME = `<!doctype html><html><head><title> Clínica Sorriso | Dentista </title>
<meta name="viewport" content="width=device-width"><meta name="generator" content="WordPress 5.2">
</head><body><h1>Sorriso</h1>
<a href="/sobre">Sobre nós</a> <a href="/tratamentos/">Tratamentos</a> <a href="/quebrado">Blog</a> <a href="/sumiu">Equipe</a>
<a href="https://www.instagram.com/x">Insta</a> <a href="https://wa.me/5561999990000">WhatsApp</a> <a href="tel:+556133221100">Ligar</a>
<a href="/arquivo.pdf">PDF</a> <a href="#topo">topo</a> <a href="mailto:a@b.com">e-mail</a>
<img src="http://cdn.antigo.com/logo.png"><script src="https://tawk.ex/x.js"></script>
<form action="/enviar.php" method="post"><input name="n"></form>
<footer>© 2019 Clínica Sorriso. Todos os direitos reservados.</footer></body></html>`;

function navFalsa(paginas: Record<string, Partial<RespostaPagina> | Error>): Navegacao & { pedidos: string[] } {
  const pedidos: string[] = [];
  return {
    pedidos,
    async get(url) {
      pedidos.push(url);
      const p = paginas[url];
      if (p instanceof Error) throw p;
      if (!p) return { status: 404, urlFinal: url, corpo: 'não encontrado', contentType: 'text/html' };
      return { status: 200, urlFinal: url, corpo: '', contentType: 'text/html', ...p };
    },
  };
}
const erro = (code: string) => Object.assign(new Error('fetch failed'), { cause: { code } });

describe('lerHtml', () => {
  it('extrai título, viewport, WhatsApp, telefone, links internos, formulário, conteúdo misto e ano', () => {
    const l = lerHtml(HOME, 'https://www.clinica.com.br/');
    expect(l).toMatchObject({ viewport: true, titulo: 'Clínica Sorriso | Dentista', descricao: null, h1: 1, gerador: 'WordPress 5.2' });
    expect(l.whatsapp).toEqual(['https://wa.me/5561999990000']);
    expect(l.telefones).toEqual(['tel:+556133221100']);
    expect(l.internos.map((x) => x.url)).toEqual(['https://www.clinica.com.br/sobre', 'https://www.clinica.com.br/tratamentos/',
      'https://www.clinica.com.br/quebrado', 'https://www.clinica.com.br/sumiu']);
    expect(l.formularios).toEqual([{ action: '/enviar.php', metodo: 'post' }]);
    expect(l.misto).toEqual(['http://cdn.antigo.com/logo.png']);
    expect(l.anos).toEqual([2019]);
  });
});

describe('lerSite', () => {
  it('lê o site, checa links, formulário e sitemap', async () => {
    const nav = navFalsa({
      'https://clinica.com.br/': { urlFinal: 'https://www.clinica.com.br/', corpo: HOME },
      'http://www.clinica.com.br/': { urlFinal: 'https://www.clinica.com.br/' },
      'https://www.clinica.com.br/sobre': { corpo: '<html><body><h1>Sobre</h1><footer>© 2018-2026</footer></body></html>' },
      'https://www.clinica.com.br/tratamentos/': { corpo: '<html><body>ok</body></html>' },
      'https://www.clinica.com.br/sumiu': erro('ECONNRESET'),
      'https://www.clinica.com.br/enviar.php': { status: 405 },
      'https://www.clinica.com.br/sitemap.xml': { corpo: '<?xml version="1.0"?><urlset></urlset>' },
    });
    const s = await lerSite(nav, 'https://clinica.com.br/', { pausaMs: 0, anoAtual: 2026 });
    expect(s).toMatchObject({ respondeu: true, status_home: 200, https: true, certificado_ok: true, http_redireciona_https: true,
      viewport: true, h1: 1, sitemap: true, chat_widget: null, ano_rodape: 2026, url_final: 'https://www.clinica.com.br/' });
    expect(s.links_internos.map((l) => [l.texto, l.status])).toEqual([['Sobre nós', 200], ['Tratamentos', 200], ['Blog', 404], ['Equipe', null]]);
    expect(s.formularios).toEqual([{ pagina: 'https://www.clinica.com.br/', action: '/enviar.php', metodo: 'post', status_destino: 405 }]);
    expect(s.conteudo_misto).toEqual(['http://cdn.antigo.com/logo.png']);
    expect(nav.pedidos).not.toContain('https://www.clinica.com.br/arquivo.pdf');
  });

  it('certificado inválido: lê pelo http e marca o certificado', async () => {
    const nav = navFalsa({
      'https://velho.com.br/': erro('CERT_HAS_EXPIRED'),
      'http://velho.com.br/': { corpo: '<html><head><title>Velho</title></head><body>site</body></html>' },
    });
    const s = await lerSite(nav, 'https://velho.com.br/', { pausaMs: 0 });
    expect(s).toMatchObject({ respondeu: true, https: false, certificado_ok: false, viewport: false });
  });

  it('fora do ar: não responde', async () => {
    const nav = navFalsa({ 'https://fora.com.br/': erro('ENOTFOUND'), 'http://fora.com.br/': erro('ENOTFOUND') });
    const s = await lerSite(nav, 'https://fora.com.br/', { pausaMs: 0 });
    expect(s).toMatchObject({ respondeu: false, erro: 'domínio não encontrado' });
  });
});

describe('auditar', () => {
  const nav = navFalsa({ 'https://clinica.com.br/': { corpo: HOME }, 'https://clinica.com.br/sitemap.xml': { status: 404 }, 'https://clinica.com.br/robots.txt': { status: 404 } });
  const psiOk = async (_u: string, estrategia: 'mobile' | 'desktop') => ({
    estrategia, desempenho: estrategia === 'mobile' ? 25 : 70, seo: 80, acessibilidade: 80, boas_praticas: 80, lcp_ms: 6000,
    cls: 0.1, tbt_ms: 500, viewport_ok: true, https_ok: true, url_final: null, screenshot: null,
  });

  it('monta o diagnóstico do contrato', async () => {
    const d = await auditar({ empresa_id: '11111111-1111-1111-1111-111111111111', url: 'https://clinica.com.br/', tentativas: 1 },
      { nav, psi: psiOk, tentativasPsi: 4, agora: () => new Date('2026-11-14T12:00:00Z') });
    expect(d.motor).toBe('audit@0.1.0');
    // lento no celular + 3 links quebrados + formulário que envia para página inexistente (graves) → B
    expect(d.classe).toBe('B');
    expect(d.achados.filter((a) => a.gravidade === 'grave').map((a) => a.codigo)).toEqual(['muito_lento_celular', 'links_quebrados', 'formulario_quebrado']);
    expect(d.achados.some((a) => a.codigo === 'rodape_antigo')).toBe(true);
    expect(d.sinais.links_checados).toBe(4);
  });

  it('PageSpeed sem cota: repete depois; na última tentativa segue só com o HTML', async () => {
    const semCota = async () => { throw new ErroTemporario('PageSpeed HTTP 429 (cota)'); };
    await expect(auditar({ empresa_id: '11111111-1111-1111-1111-111111111111', url: 'https://clinica.com.br/', tentativas: 1 },
      { nav, psi: semCota, tentativasPsi: 4 })).rejects.toBeInstanceOf(ErroTemporario);
    const d = await auditar({ empresa_id: '11111111-1111-1111-1111-111111111111', url: 'https://clinica.com.br/', tentativas: 4 },
      { nav, psi: semCota, tentativasPsi: 4 });
    expect(d.psi.mobile).toBeNull();
    expect(d.achados.some((a) => a.codigo === 'sem_pagespeed')).toBe(true);
  });
});
