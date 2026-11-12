import type { Rede, RespostaHttp } from '../src/http.ts';

/** Rede falsa: DNS e páginas definidos no teste. Qualquer coisa não definida = inexistente/erro de conexão. */
export function redeFalsa(cfg: {
  dns?: Record<string, string[] | 'erro'>;
  paginas?: Record<string, Partial<RespostaHttp> & { corpo: string } | 'erro'>;
  post?: (url: string, corpo: unknown) => { status: number; json: unknown };
}): Rede & { chamadas: string[] } {
  const chamadas: string[] = [];
  return {
    chamadas,
    async resolver(host) {
      chamadas.push(`dns ${host}`);
      const v = cfg.dns?.[host];
      if (v === 'erro') throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
      return v ?? null;
    },
    async get(url) {
      chamadas.push(`get ${url}`);
      const p = cfg.paginas?.[url] ?? cfg.paginas?.[url.replace(/\/$/, '')];
      if (!p || p === 'erro') throw new Error('connect ECONNREFUSED');
      return { status: 200, urlFinal: url, contentType: 'text/html; charset=utf-8', ...p };
    },
    async postJson(url, corpo) {
      chamadas.push(`post ${url}`);
      if (!cfg.post) throw new Error('post não configurado');
      return cfg.post(url, corpo);
    },
  };
}

export const htmlSite = (conteudo: string) =>
  `<!doctype html><html><head><title>Site</title></head><body><nav><a href="/">Início</a><a href="/contato">Contato</a></nav>
   <main>${conteudo}</main><footer>Todos os direitos reservados. Atendimento de segunda a sexta, agende sua avaliação conosco.
   Siga-nos nas redes sociais para novidades e promoções exclusivas para nossos clientes.</footer></body></html>`;
