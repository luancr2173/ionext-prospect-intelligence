import {
  classificarUrl, confirmarTitularidade, normalizarNome, pareceParking, type DadosTitularidade,
} from '@ionext/dominio';
import type { Rede } from '../http.ts';

export type EstadoSite =
  | { estado: 'inexistente' }                                  // DNS sem endereço
  | { estado: 'erro'; detalhe: string }                        // falha transitória
  | { estado: 'sem_resposta'; url: string; detalhe: string }   // DNS ok, HTTP falhou/4xx/5xx
  | { estado: 'parking'; url: string }                         // página genérica/à venda
  | { estado: 'redireciona_rede'; url: string; rede: string }  // domínio só aponta para Instagram etc.
  | { estado: 'ativo'; url: string; html: string };

/** Registro de cada checagem para virar evidência (fonte dns/http). */
export interface RegistroChecagem { alvo: string; estado: string; url_final?: string; detalhe?: string; em: string }

export async function checarDominio(rede: Rede, dominio: string): Promise<EstadoSite> {
  let enderecos: string[] | null;
  try {
    enderecos = await rede.resolver(dominio);
  } catch (e) {
    return { estado: 'erro', detalhe: `dns: ${(e as Error).message}` };
  }
  if (!enderecos) return { estado: 'inexistente' };
  return checarUrl(rede, `https://${dominio}/`);
}

export async function checarUrl(rede: Rede, url: string): Promise<EstadoSite> {
  let ultimoErro = '';
  const tentativas = url.startsWith('https://') ? [url, url.replace('https://', 'http://')] : [url];
  for (const u of tentativas) {
    try {
      const r = await rede.get(u);
      const tipo = classificarUrl(r.urlFinal);
      if (tipo.tipo === 'rede') return { estado: 'redireciona_rede', url: r.urlFinal, rede: tipo.rede };
      if (r.status >= 400) { ultimoErro = `HTTP ${r.status}`; continue; }
      if (!/html/i.test(r.contentType) && r.contentType) { ultimoErro = `conteúdo ${r.contentType}`; continue; }
      if (pareceParking(r.corpo)) return { estado: 'parking', url: r.urlFinal };
      return { estado: 'ativo', url: r.urlFinal, html: r.corpo };
    } catch (e) {
      ultimoErro = (e as Error).message;
    }
  }
  return { estado: 'sem_resposta', url, detalhe: ultimoErro };
}

export type AvaliacaoSite =
  | { tipo: 'proprio'; url: string; acessivel: true; sinais: string[] }
  | { tipo: 'proprio_fora_do_ar'; url: string }
  | { tipo: 'fraco'; url: string; detalhe: string }    // há indício, sem prova → inconclusivo
  | { tipo: 'terceiro' }                                // site não tem relação com a empresa
  | { tipo: 'rede'; url: string; rede: string }
  | { tipo: 'nada' }
  | { tipo: 'erro'; detalhe: string };

/**
 * Avalia um site ativo quanto à titularidade.
 * `confiavel` = a origem já prova que é da empresa (domínio do e-mail declarado na Receita, tag do OSM no POI casado).
 */
export function avaliarTitularidade(
  s: Extract<EstadoSite, { estado: 'ativo' }>, dados: DadosTitularidade, confiavel: boolean,
): AvaliacaoSite {
  const t = confirmarTitularidade(s.html, dados);
  if (t.confirmado) return { tipo: 'proprio', url: s.url, acessivel: true, sinais: t.sinais };
  if (confiavel) return { tipo: 'proprio', url: s.url, acessivel: true, sinais: ['origem confiável'] };
  // Indício fraco: todos os termos do nome aparecem, mas sem CNPJ, telefone ou local → revisão humana
  const texto = normalizarNome(s.html.replace(/<[^>]+>/g, ' '));
  const nomeAparece = dados.nomes.some((n) => {
    const tokens = normalizarNome(n).split(' ').filter((t) => t.length > 2);
    return tokens.length > 0 && tokens.every((t) => texto.includes(t));
  });
  if (nomeAparece) return { tipo: 'fraco', url: s.url, detalhe: 'nome aparece, sem CNPJ/telefone/endereço' };
  return { tipo: 'terceiro' };
}

/** Domínio → avaliação completa (DNS + HTTP + titularidade). */
export async function avaliarDominio(rede: Rede, dominio: string, dados: DadosTitularidade, confiavel: boolean):
  Promise<{ avaliacao: AvaliacaoSite; registro: RegistroChecagem }> {
  const s = await checarDominio(rede, dominio);
  const registro: RegistroChecagem = { alvo: dominio, estado: s.estado, em: new Date().toISOString() };
  if ('url' in s) registro.url_final = s.url;
  if ('detalhe' in s) registro.detalhe = s.detalhe;

  switch (s.estado) {
    case 'inexistente': return { avaliacao: { tipo: 'nada' }, registro };
    case 'erro': return { avaliacao: { tipo: 'erro', detalhe: s.detalhe }, registro };
    case 'redireciona_rede': return { avaliacao: { tipo: 'rede', url: s.url, rede: s.rede }, registro };
    case 'sem_resposta':
    case 'parking':
      // Só sabemos que o domínio é dela se a origem for confiável; senão, é um domínio qualquer.
      return { avaliacao: confiavel ? { tipo: 'proprio_fora_do_ar', url: `https://${dominio}` } : { tipo: 'nada' }, registro };
    case 'ativo': return { avaliacao: avaliarTitularidade(s, dados, confiavel), registro };
  }
}
