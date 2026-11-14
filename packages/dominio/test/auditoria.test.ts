import { describe, expect, it } from 'vitest';
import { classeDosAchados, diagnosticarSite, lerPsi, type MetricasPsi, type SinaisSite } from '../src/index.ts';

const bom: SinaisSite = {
  url_inicial: 'https://clinica.com.br', url_final: 'https://clinica.com.br/', respondeu: true, status_home: 200, erro: null,
  https: true, certificado_ok: true, http_redireciona_https: true, viewport: true,
  titulo: 'Clínica Sorriso — Dentista na Asa Norte', descricao: 'Implantes e clareamento na Asa Norte.', h1: 1,
  whatsapp: ['https://wa.me/5561999990000'], telefones: ['tel:+556133221100'], formularios: [],
  links_internos: [{ url: 'https://clinica.com.br/sobre', status: 200, pagina_origem: 'https://clinica.com.br/', texto: 'Sobre' }],
  paginas: [{ url: 'https://clinica.com.br/', status: 200 }], ano_rodape: 2026, conteudo_misto: [], sitemap: true,
  chat_widget: null, gerador: null, depende_js: false,
};
const psi = (desempenho: number, extra: Partial<MetricasPsi> = {}): MetricasPsi => ({
  estrategia: 'mobile', desempenho, seo: 92, acessibilidade: 88, boas_praticas: 90, lcp_ms: 2100, cls: 0.02, tbt_ms: 120,
  viewport_ok: true, https_ok: true, url_final: 'https://clinica.com.br/', screenshot: null, ...extra,
});

describe('lerPsi', () => {
  it('lê notas, métricas e o print da resposta do PageSpeed', () => {
    const m = lerPsi({
      lighthouseResult: {
        finalDisplayedUrl: 'https://x.com.br/',
        categories: { performance: { score: 0.27 }, seo: { score: 0.83 }, accessibility: { score: 0.9 }, 'best-practices': { score: null } },
        audits: {
          'largest-contentful-paint': { numericValue: 6321.4 }, 'cumulative-layout-shift': { numericValue: 0.12345 },
          'total-blocking-time': { numericValue: 840.2 }, viewport: { score: 0 }, 'is-on-https': { score: 1 },
          'final-screenshot': { details: { data: 'data:image/jpeg;base64,AAA' } },
        },
      },
    }, 'mobile');
    expect(m).toMatchObject({ desempenho: 27, seo: 83, acessibilidade: 90, boas_praticas: null, lcp_ms: 6321, cls: 0.123, tbt_ms: 840,
      viewport_ok: false, https_ok: true, url_final: 'https://x.com.br/', screenshot: 'data:image/jpeg;base64,AAA' });
    expect(lerPsi({}, 'desktop').desempenho).toBeNull();
  });
});

describe('diagnosticarSite', () => {
  it('site moderno é D, com pontos positivos e oportunidade de IA', () => {
    const d = diagnosticarSite(bom, { mobile: psi(78), desktop: psi(95, { estrategia: 'desktop' }) }, 2026);
    expect(d.classe).toBe('D');
    expect(d.achados.map((a) => a.codigo)).toEqual(['sem_atendimento_automatico']);
    expect(d.pontos_positivos.map((p) => p.codigo)).toEqual(expect.arrayContaining(['https', 'responsivo', 'rapido_celular', 'rapido_desktop', 'whatsapp', 'seo_basico']));
    expect(d.resumo).toMatch(/^Site moderno/);
  });

  it('sem HTTPS e sem versão para celular: B (2 graves)', () => {
    const d = diagnosticarSite({ ...bom, https: false, viewport: false }, { mobile: psi(65, { viewport_ok: null }), desktop: null }, 2026);
    expect(d.classe).toBe('B');
    expect(d.achados.filter((a) => a.gravidade === 'grave').map((a) => a.codigo)).toEqual(['sem_https', 'sem_versao_celular']);
    expect(d.resumo).toBe('Site desatualizado: sem conexão segura (https) e não está adaptado para celular.');
  });

  it('1 grave é C; 3 moderados também é C; sinais isolados não bastam', () => {
    expect(diagnosticarSite(bom, { mobile: psi(22), desktop: null }, 2026).classe).toBe('C');
    const tres = diagnosticarSite({ ...bom, descricao: null, whatsapp: [], telefones: [], ano_rodape: 2021 }, { mobile: psi(80), desktop: null }, 2026);
    expect(tres.achados.filter((a) => a.gravidade === 'moderado').map((a) => a.codigo)).toEqual(['seo_incompleto', 'sem_contato_clicavel', 'rodape_antigo']);
    expect(tres.classe).toBe('C');
    // só o rodapé antigo não torna o site desatualizado
    expect(diagnosticarSite({ ...bom, ano_rodape: 2019 }, { mobile: psi(80), desktop: null }, 2026).classe).toBe('D');
  });

  it('links e formulário: 2+ links quebrados é grave; 1 é moderado; form 404 é grave; 405 não conta', () => {
    const link = (url: string, status: number | null) => ({ url, status, pagina_origem: 'https://clinica.com.br/', texto: url.split('/').pop()! });
    const dois = diagnosticarSite({ ...bom, links_internos: [link('https://clinica.com.br/a', 404), link('https://clinica.com.br/b', null)] }, { mobile: psi(80), desktop: null }, 2026);
    expect(dois.achados[0]).toMatchObject({ codigo: 'links_quebrados', gravidade: 'grave' });
    const um = diagnosticarSite({ ...bom, links_internos: [link('https://clinica.com.br/a', 404)] }, { mobile: psi(80), desktop: null }, 2026);
    expect(um.achados[0]).toMatchObject({ codigo: 'link_quebrado', gravidade: 'moderado' });
    const form = (status: number) => diagnosticarSite({ ...bom, formularios: [{ pagina: 'https://clinica.com.br/contato', action: '/enviar.php', metodo: 'post', status_destino: status }] },
      { mobile: psi(80), desktop: null }, 2026);
    expect(form(404).achados[0]).toMatchObject({ codigo: 'formulario_quebrado', evidencia: 'action="/enviar.php" → 404' });
    expect(form(405).achados.some((a) => a.codigo === 'formulario_quebrado')).toBe(false);
  });

  it('site fora do ar é B, com um único achado', () => {
    const d = diagnosticarSite({ ...bom, respondeu: false, status_home: null, erro: 'tempo esgotado' }, { mobile: null, desktop: null }, 2026);
    expect(d.classe).toBe('B');
    expect(d.achados).toHaveLength(1);
    expect(d.achados[0]).toMatchObject({ codigo: 'fora_do_ar', evidencia: 'tempo esgotado' });
  });

  it('sem PageSpeed, a classe sai só do HTML (desempenho não conta)', () => {
    const d = diagnosticarSite(bom, { mobile: null, desktop: null }, 2026);
    expect(d.classe).toBe('D');
    expect(d.pontos_positivos.some((p) => p.codigo === 'rapido_celular')).toBe(false);
  });

  it('classeDosAchados aplica a mesma regra na Central', () => {
    expect(classeDosAchados([{ codigo: 'x', gravidade: 'grave' }, { codigo: 'y', gravidade: 'grave' }])).toBe('B');
    expect(classeDosAchados([{ codigo: 'x', gravidade: 'moderado' }, { codigo: 'y', gravidade: 'moderado' }])).toBe('D');
    expect(classeDosAchados([{ codigo: 'fora_do_ar', gravidade: 'grave' }])).toBe('B');
  });
});
