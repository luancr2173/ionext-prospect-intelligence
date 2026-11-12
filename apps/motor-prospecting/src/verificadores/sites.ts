import {
  avaliarSitePara, classificarUrl, dominioCombinaComNome, ehProvedorEmail, pareceParking,
  type DadosTitularidade, type OrigemSite,
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

/** Avalia um site ativo quanto à titularidade, conforme a origem do link (regra única em @ionext/dominio). */
export function avaliarTitularidade(
  s: Extract<EstadoSite, { estado: 'ativo' }>, dados: DadosTitularidade, origem: OrigemSite,
): AvaliacaoSite {
  const v = avaliarSitePara(s.url, s.html, dados, origem);
  if (v.tipo === 'proprio') return { tipo: 'proprio', url: s.url, acessivel: true, sinais: v.sinais };
  if (v.tipo === 'fraco') return { tipo: 'fraco', url: s.url, detalhe: v.detalhe };
  return { tipo: 'terceiro' };
}

/** Domínio → avaliação completa (DNS + HTTP + titularidade). */
export async function avaliarDominio(rede: Rede, dominio: string, dados: DadosTitularidade, origem: 'email' | 'nome'):
  Promise<{ avaliacao: AvaliacaoSite; registro: RegistroChecagem }> {
  const s = await checarDominio(rede, dominio);
  const registro: RegistroChecagem = { alvo: dominio, estado: s.estado, em: new Date().toISOString() };
  if ('url' in s) registro.url_final = s.url;
  if ('detalhe' in s) registro.detalhe = s.detalhe;

  switch (s.estado) {
    case 'inexistente': return { avaliacao: { tipo: 'nada' }, registro };
    case 'erro': return { avaliacao: { tipo: 'erro', detalhe: s.detalhe }, registro };
    case 'redireciona_rede':
      // Domínio que redireciona para um perfil: só é da empresa se o domínio tem a cara do nome
      return { avaliacao: dominioCombinaComNome(dominio, dados.nomes, dados.genericas ?? []) ? { tipo: 'rede', url: s.url, rede: s.rede } : { tipo: 'nada' }, registro };
    case 'sem_resposta':
    case 'parking':
    {
      // Fora do ar só conta como "dela" se veio do e-mail declarado E o domínio tem a cara do nome
      const dela = origem === 'email' && !ehProvedorEmail(dominio) && dominioCombinaComNome(dominio, dados.nomes, dados.genericas ?? []);
      return { avaliacao: dela ? { tipo: 'proprio_fora_do_ar', url: `https://${dominio}` } : { tipo: 'nada' }, registro };
    }
    case 'ativo': return { avaliacao: avaliarTitularidade(s, dados, origem), registro };
  }
}
