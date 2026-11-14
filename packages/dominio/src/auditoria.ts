/**
 * Motor 02 — regras da auditoria de sites (seção 5 da arquitetura).
 * Funções puras: recebem o que o motor mediu (PageSpeed + leitura do HTML) e devolvem
 * achados com evidência, pontos positivos e a classe comercial B/C/D por regra explícita.
 *
 * Regra de classe:
 *   B (desatualizado)       site fora do ar, ou 2+ falhas graves
 *   C (funcional, com problemas)  1 falha grave, ou 3+ problemas moderados
 *   D (moderno)             nenhum dos anteriores
 * Nada é classificado por "impressão": cada achado aponta a página e o trecho que o sustenta.
 */

export type Gravidade = 'grave' | 'moderado' | 'oportunidade' | 'info';
export type ClasseSite = 'B' | 'C' | 'D';

export interface Achado {
  codigo: string;
  gravidade: Gravidade;
  titulo: string;
  detalhe: string;
  pagina: string | null;
  evidencia: string | null;
  recomendacao: string;
  servico: string | null;
}

export interface PontoPositivo {
  codigo: string;
  titulo: string;
  detalhe: string;
}

/** Métricas de uma rodada do PageSpeed Insights (Lighthouse). Notas de 0 a 100. */
export interface MetricasPsi {
  estrategia: 'mobile' | 'desktop';
  desempenho: number | null;
  seo: number | null;
  acessibilidade: number | null;
  boas_praticas: number | null;
  lcp_ms: number | null;
  cls: number | null;
  tbt_ms: number | null;
  viewport_ok: boolean | null;
  https_ok: boolean | null;
  url_final: string | null;
  screenshot: string | null;
}

export interface LinkChecado {
  url: string;
  status: number | null; // null = sem resposta (timeout, DNS, conexão recusada)
  pagina_origem: string;
  texto: string;
}

export interface FormularioEncontrado {
  pagina: string;
  action: string | null;
  metodo: string;
  status_destino: number | null | undefined; // undefined = não checado (sem action própria / outro domínio)
}

/** O que o crawler leu do site (sem navegador: HTML das páginas e cabeçalhos). */
export interface SinaisSite {
  url_inicial: string;
  url_final: string | null;
  respondeu: boolean;
  status_home: number | null;
  erro: string | null;
  https: boolean;
  certificado_ok: boolean | null;
  http_redireciona_https: boolean | null;
  viewport: boolean;
  titulo: string | null;
  descricao: string | null;
  h1: number;
  whatsapp: string[];
  telefones: string[];
  formularios: FormularioEncontrado[];
  links_internos: LinkChecado[];
  paginas: { url: string; status: number | null }[];
  ano_rodape: number | null;
  conteudo_misto: string[];
  sitemap: boolean | null;
  chat_widget: string | null;
  gerador: string | null;
  depende_js: boolean;
}

export interface Diagnostico {
  classe: ClasseSite;
  achados: Achado[];
  pontos_positivos: PontoPositivo[];
  resumo: string;
  servicos_recomendados: string[];
}

const SERVICO = {
  reformulacao: 'reformulação do site',
  desempenho: 'otimização de desempenho',
  seguranca: 'hospedagem com HTTPS e manutenção',
  seo: 'SEO básico (título, descrição e estrutura)',
  conversao: 'botão de WhatsApp e contato clicável',
  manutencao: 'manutenção e correção de links e formulários',
  ia: 'atendimento com IA no WhatsApp',
} as const;

const trecho = (t: string | null | undefined, max = 140) => (t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : null);

/** Lê a resposta do PageSpeed Insights v5 (runPagespeed). Campos ausentes ficam null. */
export function lerPsi(json: unknown, estrategia: 'mobile' | 'desktop'): MetricasPsi {
  const lr = (json as { lighthouseResult?: Record<string, unknown> })?.lighthouseResult ?? {};
  const cat = (lr.categories ?? {}) as Record<string, { score?: number | null }>;
  const aud = (lr.audits ?? {}) as Record<string, { score?: number | null; numericValue?: number; details?: { data?: string } }>;
  const nota = (k: string) => (typeof cat[k]?.score === 'number' ? Math.round(cat[k]!.score! * 100) : null);
  const num = (k: string) => (typeof aud[k]?.numericValue === 'number' ? aud[k]!.numericValue! : null);
  const passou = (k: string) => (typeof aud[k]?.score === 'number' ? aud[k]!.score! >= 0.9 : null);
  const shot = aud['final-screenshot']?.details?.data;
  return {
    estrategia,
    desempenho: nota('performance'),
    seo: nota('seo'),
    acessibilidade: nota('accessibility'),
    boas_praticas: nota('best-practices'),
    lcp_ms: num('largest-contentful-paint') != null ? Math.round(num('largest-contentful-paint')!) : null,
    cls: num('cumulative-layout-shift') != null ? Math.round(num('cumulative-layout-shift')! * 1000) / 1000 : null,
    tbt_ms: num('total-blocking-time') != null ? Math.round(num('total-blocking-time')!) : null,
    viewport_ok: passou('viewport'),
    https_ok: passou('is-on-https'),
    url_final: typeof lr.finalDisplayedUrl === 'string' ? lr.finalDisplayedUrl : typeof lr.finalUrl === 'string' ? lr.finalUrl : null,
    screenshot: typeof shot === 'string' && shot.startsWith('data:image/') ? shot : null,
  };
}

/** Classe pela contagem de achados (a mesma regra roda no motor e na Central). */
export function classeDosAchados(achados: Pick<Achado, 'codigo' | 'gravidade'>[]): ClasseSite {
  if (achados.some((a) => a.codigo === 'fora_do_ar')) return 'B';
  const graves = achados.filter((a) => a.gravidade === 'grave').length;
  const moderados = achados.filter((a) => a.gravidade === 'moderado').length;
  if (graves >= 2) return 'B';
  if (graves === 1 || moderados >= 3) return 'C';
  return 'D';
}

export function diagnosticarSite(
  s: SinaisSite,
  psi: { mobile: MetricasPsi | null; desktop: MetricasPsi | null },
  anoAtual = new Date().getFullYear(),
): Diagnostico {
  const achados: Achado[] = [];
  const positivos: PontoPositivo[] = [];
  const home = s.url_final ?? s.url_inicial;
  const add = (a: Achado) => achados.push(a);

  // ---- site fora do ar: é o único achado que importa
  if (!s.respondeu || (s.status_home != null && s.status_home >= 500)) {
    add({
      codigo: 'fora_do_ar', gravidade: 'grave', titulo: 'O site não abre',
      detalhe: s.erro ? `A página inicial não respondeu (${s.erro}).` : `A página inicial respondeu com erro HTTP ${s.status_home}.`,
      pagina: s.url_inicial, evidencia: s.erro ?? `HTTP ${s.status_home}`,
      recomendacao: 'Colocar o site de volta no ar ou criar um novo, para quem procura a empresa no Google encontrar informação.',
      servico: SERVICO.reformulacao,
    });
    return fechar('B');
  }

  const m = psi.mobile;
  const d = psi.desktop;

  // ---- graves
  if (!s.https || s.certificado_ok === false) {
    add({
      codigo: 'sem_https', gravidade: 'grave', titulo: 'Sem conexão segura (HTTPS)',
      detalhe: s.certificado_ok === false
        ? 'O certificado de segurança é inválido: o navegador avisa que o site "não é seguro".'
        : 'O site abre em http://, e os navegadores mostram "Não seguro" na barra de endereço.',
      pagina: home, evidencia: home,
      recomendacao: 'Ativar HTTPS com certificado válido e redirecionar todo acesso para https://.',
      servico: SERVICO.seguranca,
    });
  } else {
    positivos.push({ codigo: 'https', titulo: 'Conexão segura', detalhe: 'O site abre em HTTPS com certificado válido.' });
  }

  const viewportOk = m?.viewport_ok ?? s.viewport;
  if (!viewportOk) {
    add({
      codigo: 'sem_versao_celular', gravidade: 'grave', titulo: 'Não está adaptado para celular',
      detalhe: 'A página não declara layout para telas pequenas: no celular aparece reduzida e é preciso dar zoom.',
      pagina: home, evidencia: m?.viewport_ok === false ? 'PageSpeed: auditoria "viewport" reprovada' : 'sem <meta name="viewport"> no HTML',
      recomendacao: 'Refazer o layout responsivo, pensado primeiro para o celular.',
      servico: SERVICO.reformulacao,
    });
  } else {
    positivos.push({ codigo: 'responsivo', titulo: 'Preparado para celular', detalhe: 'A página declara layout responsivo.' });
  }

  if (m?.desempenho != null) {
    if (m.desempenho < 30) {
      add({
        codigo: 'muito_lento_celular', gravidade: 'grave', titulo: 'Muito lento no celular',
        detalhe: `Nota de desempenho ${m.desempenho}/100 no celular${m.lcp_ms ? `; o conteúdo principal leva ${(m.lcp_ms / 1000).toFixed(1)} s para aparecer` : ''}.`,
        pagina: m.url_final ?? home, evidencia: `PageSpeed Insights (celular): desempenho ${m.desempenho}`,
        recomendacao: 'Otimizar imagens, scripts e hospedagem para a página carregar rápido no 4G.',
        servico: SERVICO.desempenho,
      });
    } else if (m.desempenho < 60) {
      add({
        codigo: 'lento_celular', gravidade: 'moderado', titulo: 'Lento no celular',
        detalhe: `Nota de desempenho ${m.desempenho}/100 no celular${m.lcp_ms ? `; conteúdo principal em ${(m.lcp_ms / 1000).toFixed(1)} s` : ''}.`,
        pagina: m.url_final ?? home, evidencia: `PageSpeed Insights (celular): desempenho ${m.desempenho}`,
        recomendacao: 'Otimizar imagens e scripts para melhorar o tempo de carregamento.',
        servico: SERVICO.desempenho,
      });
    } else {
      positivos.push({ codigo: 'rapido_celular', titulo: m.desempenho >= 90 ? 'Muito rápido no celular' : 'Bom desempenho no celular', detalhe: `Nota ${m.desempenho}/100 no PageSpeed (celular).` });
    }
  }
  if (d?.desempenho != null && d.desempenho >= 90) {
    positivos.push({ codigo: 'rapido_desktop', titulo: 'Rápido no computador', detalhe: `Nota ${d.desempenho}/100 no PageSpeed (computador).` });
  }

  const quebrados = s.links_internos.filter((l) => l.status == null || l.status === 404 || l.status === 410 || l.status >= 500);
  if (quebrados.length >= 2) {
    add({
      codigo: 'links_quebrados', gravidade: 'grave', titulo: `${quebrados.length} links internos quebrados`,
      detalhe: 'Links do próprio site levam a páginas que não existem ou não respondem.',
      pagina: quebrados[0]!.pagina_origem,
      evidencia: trecho(quebrados.slice(0, 4).map((l) => `${l.texto || l.url} → ${l.status ?? 'sem resposta'}`).join('; '), 300),
      recomendacao: 'Corrigir ou remover os links quebrados e revisar o menu.',
      servico: SERVICO.manutencao,
    });
  } else if (quebrados.length === 1) {
    const l = quebrados[0]!;
    add({
      codigo: 'link_quebrado', gravidade: 'moderado', titulo: '1 link interno quebrado',
      detalhe: `O link "${trecho(l.texto, 60) || l.url}" leva a uma página que ${l.status ? `responde ${l.status}` : 'não responde'}.`,
      pagina: l.pagina_origem, evidencia: `${l.url} → ${l.status ?? 'sem resposta'}`,
      recomendacao: 'Corrigir ou remover o link.', servico: SERVICO.manutencao,
    });
  }

  const formQuebrado = s.formularios.find((f) => f.status_destino === 404 || f.status_destino === 410);
  if (formQuebrado) {
    add({
      codigo: 'formulario_quebrado', gravidade: 'grave', titulo: 'Formulário de contato não funciona',
      detalhe: 'O formulário envia para um endereço que não existe: a mensagem do cliente se perde.',
      pagina: formQuebrado.pagina, evidencia: `action="${formQuebrado.action}" → ${formQuebrado.status_destino}`,
      recomendacao: 'Refazer o envio do formulário (com aviso por WhatsApp/e-mail para a equipe).',
      servico: SERVICO.manutencao,
    });
  }

  // ---- moderados
  const faltaSeo = [!s.titulo && 'título da página', !s.descricao && 'descrição para o Google', s.h1 === 0 && 'título principal (H1)'].filter(Boolean) as string[];
  if (faltaSeo.length || (m?.seo != null && m.seo < 70)) {
    add({
      codigo: 'seo_incompleto', gravidade: 'moderado', titulo: 'SEO básico incompleto',
      detalhe: faltaSeo.length ? `Falta: ${faltaSeo.join(', ')}.` : `Nota de SEO ${m!.seo}/100 no PageSpeed.`,
      pagina: home, evidencia: faltaSeo.length ? `title=${s.titulo ? `"${trecho(s.titulo, 60)}"` : 'ausente'}; description=${s.descricao ? 'presente' : 'ausente'}; h1=${s.h1}` : `PageSpeed SEO ${m!.seo}`,
      recomendacao: 'Escrever título e descrição com o serviço e o bairro, e organizar os títulos da página.',
      servico: SERVICO.seo,
    });
  } else {
    positivos.push({ codigo: 'seo_basico', titulo: 'SEO básico em ordem', detalhe: `Título, descrição e H1 presentes${m?.seo != null ? `; SEO ${m.seo}/100` : ''}.` });
  }

  if (s.whatsapp.length === 0 && s.telefones.length === 0) {
    add({
      codigo: 'sem_contato_clicavel', gravidade: 'moderado', titulo: 'Sem botão de WhatsApp nem telefone clicável',
      detalhe: 'Quem está no celular precisa copiar o número para entrar em contato.',
      pagina: home, evidencia: 'nenhum link wa.me / api.whatsapp.com / tel: nas páginas lidas',
      recomendacao: 'Colocar botão de WhatsApp fixo e telefone clicável em todas as páginas.',
      servico: SERVICO.conversao,
    });
  } else {
    if (s.whatsapp.length) positivos.push({ codigo: 'whatsapp', titulo: 'Botão de WhatsApp', detalhe: 'O site tem link direto para o WhatsApp.' });
    if (s.telefones.length) positivos.push({ codigo: 'telefone', titulo: 'Telefone clicável', detalhe: 'No celular, um toque já liga para a empresa.' });
  }

  if (s.https && s.conteudo_misto.length) {
    add({
      codigo: 'conteudo_inseguro', gravidade: 'moderado', titulo: 'Partes da página carregadas sem segurança',
      detalhe: `${s.conteudo_misto.length} recurso(s) carregado(s) por http:// numa página https:// (imagens ou scripts podem ser bloqueados).`,
      pagina: home, evidencia: trecho(s.conteudo_misto.slice(0, 3).join(' '), 300),
      recomendacao: 'Trocar os endereços para https://.', servico: SERVICO.seguranca,
    });
  }

  if (s.ano_rodape != null && s.ano_rodape <= anoAtual - 2) {
    add({
      codigo: 'rodape_antigo', gravidade: 'moderado', titulo: `Rodapé com ano ${s.ano_rodape}`,
      detalhe: 'O ano de copyright não é atualizado há pelo menos 2 anos: sinal de que o site não recebe manutenção (vale junto com outros sinais).',
      pagina: home, evidencia: `© ${s.ano_rodape}`,
      recomendacao: 'Revisar o conteúdo e manter o site atualizado.', servico: SERVICO.reformulacao,
    });
  } else if (s.ano_rodape != null && s.ano_rodape >= anoAtual - 1) {
    positivos.push({ codigo: 'rodape_atual', titulo: 'Conteúdo com sinal de atualização', detalhe: `Rodapé com ano ${s.ano_rodape}.` });
  }

  // ---- oportunidades (não contam para a classe)
  if (!s.chat_widget) {
    add({
      codigo: 'sem_atendimento_automatico', gravidade: 'oportunidade', titulo: 'Sem atendimento automático',
      detalhe: s.whatsapp.length
        ? 'O contato vai para o WhatsApp, mas não há resposta automática: fora do horário, o cliente espera.'
        : 'Não há chat nem atendimento automático no site.',
      pagina: home, evidencia: 'nenhum widget de chat conhecido no HTML',
      recomendacao: 'Atendimento com IA no WhatsApp para responder dúvidas e agendar a qualquer hora.',
      servico: SERVICO.ia,
    });
  }
  if (s.sitemap === false) {
    add({
      codigo: 'sem_sitemap', gravidade: 'info', titulo: 'Sem sitemap.xml',
      detalhe: 'O Google encontra as páginas com mais dificuldade.', pagina: home, evidencia: '/sitemap.xml não encontrado',
      recomendacao: 'Publicar o sitemap.xml e cadastrar no Google Search Console.', servico: SERVICO.seo,
    });
  }
  if (s.depende_js) {
    add({
      codigo: 'analise_limitada', gravidade: 'info', titulo: 'Análise do HTML limitada',
      detalhe: 'O conteúdo é montado por JavaScript; links e formulários podem não ter sido lidos (as notas do PageSpeed continuam válidas).',
      pagina: home, evidencia: null, recomendacao: 'Conferir manualmente se houver dúvida.', servico: null,
    });
  }

  return fechar(classeDosAchados(achados));

  function fechar(classe: ClasseSite): Diagnostico {
    const contam = achados.filter((a) => a.gravidade === 'grave' || a.gravidade === 'moderado');
    const ordem: Record<Gravidade, number> = { grave: 0, moderado: 1, oportunidade: 2, info: 3 };
    achados.sort((a, b) => ordem[a.gravidade] - ordem[b.gravidade]);
    const principais = contam.slice(0, 2).map((a) => a.titulo.toLowerCase());
    const resumo = classe === 'D'
      ? (positivos.length ? `Site moderno: ${positivos.slice(0, 2).map((p) => p.titulo.toLowerCase()).join(' e ')}.` : 'Site moderno, sem problemas relevantes.')
      : `${classe === 'B' ? 'Site desatualizado' : 'Site funciona, com pontos a melhorar'}: ${principais.join(' e ')}.`;
    const servicos = [...new Set(achados.map((a) => a.servico).filter((x): x is string => !!x))];
    return { classe, achados, pontos_positivos: positivos, resumo, servicos_recomendados: servicos };
  }
}
