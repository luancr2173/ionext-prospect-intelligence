import type { EmpresaCandidata } from '@ionext/contratos';
import {
  calcularLeadScore, classificarPresenca, classificarUrl, dominioProprioDoEmail, dominiosCandidatos, ehProvedorEmail,
  segmentoPorCnae, similaridadeNomes, type DadosTitularidade, type ResultadoVerificacao, type Verificacoes,
} from '@ionext/dominio';
import { VERSAO_MOTOR, type ConfigMotor } from '../config.ts';
import type { Sql } from '../db.ts';
import type { Rede } from '../http.ts';
import { buscarNaWeb, consultaPara, type ProvedorBusca, type ResultadoBusca, type ResultadoClaude } from '../verificadores/buscaWeb.ts';
import { canaisDoPoi, casarComCatalogo, type PoiOsm } from '../verificadores/osm.ts';
import { avaliarDominio, avaliarTitularidade, checarUrl, type RegistroChecagem } from '../verificadores/sites.ts';

/** Linha de receita.estabelecimento */
export interface Estabelecimento {
  cnpj: string;
  nome_fantasia: string | null;
  razao_social: string | null;
  situacao: string;
  data_inicio: string | null;
  cnae_principal: string;
  logradouro: string | null;
  bairro: string | null;
  cep: string | null;
  uf: string;
  municipio_nome: string;
  telefones: string[];
  email: string | null;
  porte: 'ME' | 'EPP' | 'DEMAIS' | null;
  mei: boolean | null;
  referencia: string;
}

export interface Dependencias {
  sql: Sql;
  rede: Rede;
  provedores: ProvedorBusca[];
  config: Pick<ConfigMotor, 'scoreMinimoBuscaWeb'>;
  /** null = catálogo indisponível (Overpass falhou) → V2 vira erro e a empresa fica PENDENTE */
  catalogoOsm: PoiOsm[] | null;
  agora?: () => Date;
}

export interface SaidaProcessamento {
  candidata: EmpresaCandidata;
  prioridade: number;
  buscaWeb: 'executada' | 'enfileirada_claude' | 'pulada' | 'erro';
}

const titulo = (s: string | null) =>
  s ? s.toLowerCase().replace(/(^|[\s(\/-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()).replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (m) => m.toLowerCase()) : null;

export async function processarEstabelecimento(
  d: Dependencias, e: Estabelecimento, opts: { busca_id: string | null; resultadoClaude?: ResultadoClaude | null } = { busca_id: null },
): Promise<SaidaProcessamento> {
  const agora = (d.agora ?? (() => new Date()))();
  const iso = agora.toISOString();
  const seg = segmentoPorCnae(e.cnae_principal);
  const nomes = [e.nome_fantasia, e.razao_social].filter((n): n is string => !!n && n.length > 1);
  const nomePrincipal = titulo(e.nome_fantasia || e.razao_social) ?? e.cnpj;
  const dadosTit: DadosTitularidade = { cnpj: e.cnpj, telefones: e.telefones, nomes, cidade: e.municipio_nome, bairro: e.bairro, genericas: seg?.palavras ?? [] };

  const evidencias: EmpresaCandidata['evidencias'] = [{
    ref: 'rf', fonte: 'receita', url: null, coletado_em: iso, confiabilidade: 'alta',
    payload: { referencia: e.referencia, cnae: e.cnae_principal, situacao: e.situacao, porte: e.porte, mei: e.mei },
  }];
  const contatos: EmpresaCandidata['contatos'] = [];
  const identificadores: EmpresaCandidata['identificadores'] = [{ fonte: 'receita', valor: e.cnpj }];
  const redes = new Map<string, string>(); // rede → url
  const checagens: RegistroChecagem[] = [];
  let lat: number | null = null;
  let lng: number | null = null;

  // Contatos declarados na Receita. MEI: o telefone/e-mail pode ser pessoal → não marcado como comercial (LGPD).
  const comercialReceita = e.mei !== true;
  for (const t of e.telefones) contatos.push({ tipo: 'telefone', valor: t, publico_comercial: comercialReceita, evidencia_ref: 'rf' });
  if (e.email) contatos.push({ tipo: 'email', valor: e.email, publico_comercial: comercialReceita, evidencia_ref: 'rf' });

  // ---- V2: OpenStreetMap
  let V2: ResultadoVerificacao;
  if (!d.catalogoOsm) {
    V2 = { status: 'erro', detalhe: 'catálogo OSM indisponível' };
  } else {
    const m = casarComCatalogo(d.catalogoOsm, { nomes, telefones: e.telefones, cep: e.cep, bairro: e.bairro });
    if (!m) {
      V2 = { status: 'nada_encontrado' };
    } else {
      evidencias.push({ ref: 'osm', fonte: 'osm', url: `https://www.openstreetmap.org/${m.poi.osm_id}`, coletado_em: iso,
                        confiabilidade: m.motivo === 'telefone' ? 'alta' : 'media', payload: { casamento: m.motivo, similaridade: m.similaridade, nome_osm: m.poi.nome } });
      identificadores.push({ fonte: 'osm', valor: m.poi.osm_id });
      lat = m.poi.lat; lng = m.poi.lng;
      const c = canaisDoPoi(m.poi.tags);
      for (const t of c.telefones) contatos.push({ tipo: 'telefone', valor: t, publico_comercial: true, evidencia_ref: 'osm' });
      for (const w of c.whatsapp) contatos.push({ tipo: 'whatsapp', valor: w, publico_comercial: true, evidencia_ref: 'osm' });
      for (const r of c.redes) { redes.set(r.rede, r.url); contatos.push({ tipo: r.rede as 'instagram', valor: r.url, publico_comercial: true, evidencia_ref: 'osm' }); }
      if (!c.website) {
        V2 = { status: 'nada_encontrado' };
      } else {
        const s = await checarUrl(d.rede, c.website);
        checagens.push({ alvo: c.website, estado: s.estado, em: iso, ...('url' in s ? { url_final: s.url } : {}) });
        if (s.estado === 'ativo' && avaliarTitularidade(s, dadosTit, 'osm').tipo === 'proprio') V2 = { status: 'site_encontrado', url: s.url, acessivel: true };
        else if (s.estado === 'ativo') V2 = { status: 'nada_encontrado' }; // website do POI aponta para diretório
        else if (s.estado === 'redireciona_rede') { redes.set(s.rede, s.url); V2 = { status: 'nada_encontrado' }; }
        else if (s.estado === 'erro') V2 = { status: 'erro', detalhe: s.detalhe };
        else V2 = { status: 'site_encontrado', url: c.website, acessivel: false };
      }
    }
  }

  // ---- V3: domínio do e-mail declarado
  let V3: ResultadoVerificacao = { status: 'nao_aplicavel' };
  const dominioEmailBruto = e.email ? dominioProprioDoEmail(e.email) : null;
  const dominioEmail = dominioEmailBruto && !ehProvedorEmail(dominioEmailBruto) ? dominioEmailBruto : null;
  if (dominioEmail) {
    const { avaliacao, registro } = await avaliarDominio(d.rede, dominioEmail, dadosTit, 'email');
    checagens.push(registro);
    if (avaliacao.tipo === 'proprio') V3 = { status: 'site_encontrado', url: avaliacao.url, acessivel: true };
    else if (avaliacao.tipo === 'proprio_fora_do_ar') V3 = { status: 'site_encontrado', url: avaliacao.url, acessivel: false };
    else if (avaliacao.tipo === 'rede') { redes.set(avaliacao.rede, avaliacao.url); V3 = { status: 'nada_encontrado' }; }
    else if (avaliacao.tipo === 'erro') V3 = { status: 'erro', detalhe: avaliacao.detalhe };
    else V3 = { status: 'nada_encontrado' };
  }

  // ---- V4: domínios candidatos pelo nome
  let V4: ResultadoVerificacao = { status: 'nada_encontrado' };
  {
    let inconclusivo: ResultadoVerificacao | null = null;
    let erro: string | null = null;
    for (const dom of dominiosCandidatos(nomes, seg?.palavras ?? []).filter((x) => x !== dominioEmail)) {
      const { avaliacao, registro } = await avaliarDominio(d.rede, dom, dadosTit, 'nome');
      checagens.push(registro);
      if (avaliacao.tipo === 'proprio') { V4 = { status: 'site_encontrado', url: avaliacao.url, acessivel: true }; inconclusivo = null; erro = null; break; }
      if (avaliacao.tipo === 'fraco' && !inconclusivo) inconclusivo = { status: 'inconclusivo', url: avaliacao.url, detalhe: avaliacao.detalhe };
      if (avaliacao.tipo === 'erro') erro = avaliacao.detalhe;
    }
    if (V4.status !== 'site_encontrado') {
      if (inconclusivo) V4 = inconclusivo;
      else if (erro) V4 = { status: 'erro', detalhe: erro };
    }
  }

  // ---- Pré-classificação (sem V5) para decidir se vale gastar busca web
  const montarV6 = (): Verificacoes['V6'] => ({ status: 'executado', redes: [...redes.keys()] });
  const base: Verificacoes = { V1: { status: 'nao_executado' }, V2, V3, V4, V5: { status: 'nao_executado' }, V6: montarV6() };
  const pre = classificarPresenca(base);
  const estimativa = calcularLeadScore({
    classificacao: pre.classificacao === 'PENDENTE' ? 'SEM_SITE' : pre.classificacao, // estimativa otimista p/ priorizar
    situacaoReceitaAtiva: { valor: e.situacao === 'ATIVA', evidencia_id: 'rf' },
    presencaEmFonteAberta: evidencias.some((x) => x.fonte === 'osm') ? { evidencia_id: 'osm' } : null,
    telefoneComercial: contatos.some((c) => c.tipo === 'telefone' && c.publico_comercial) ? { evidencia_id: 'rf' } : null,
    whatsappPublicado: contatos.some((c) => c.tipo === 'whatsapp') ? { evidencia_id: 'osm' } : null,
    dataAbertura: e.data_inicio ? { data: e.data_inicio, evidencia_id: 'rf' } : null,
    porte: e.porte ? { valor: e.porte, evidencia_id: 'rf' } : null,
    hoje: agora,
  });

  // ---- V5: busca web (só onde um site não encontrado mudaria a decisão, e o lead vale a cota)
  let V5: ResultadoVerificacao = { status: 'nao_executado' };
  let buscaWeb: SaidaProcessamento['buscaWeb'] = 'pulada';
  const precisa = pre.classificacao === 'SEM_SITE' || pre.classificacao === 'SOMENTE_REDES' || pre.classificacao === 'PENDENTE';
  if (precisa && (estimativa.lead_score >= d.config.scoreMinimoBuscaWeb || opts.resultadoClaude)) {
    const consulta = consultaPara(nomePrincipal, titulo(e.bairro), titulo(e.municipio_nome)!);
    let resultados: ResultadoBusca[] | null = null;
    let provedor = 'claude';
    if (opts.resultadoClaude) {
      resultados = opts.resultadoClaude.urls.map((u) => ({ url: u.url, titulo: u.observacao ?? '', trecho: '' }));
    } else {
      const s = await buscarNaWeb(d.sql, d.provedores, consulta, {
        cnpj: e.cnpj, busca_id: opts.busca_id, prioridade: estimativa.lead_score,
        contexto: { nome: nomePrincipal, razao_social: e.razao_social, bairro: titulo(e.bairro), cidade: titulo(e.municipio_nome),
                    uf: e.uf, segmento: seg?.nome ?? null, telefones: e.telefones, endereco: e.logradouro },
      });
      if (s.tipo === 'resultados') { resultados = s.resultados; provedor = s.provedor; buscaWeb = 'executada'; }
      else if (s.tipo === 'enfileirado_claude') buscaWeb = 'enfileirada_claude';
      else { buscaWeb = 'erro'; V5 = { status: 'erro', detalhe: s.detalhe }; }
    }
    if (resultados) {
      if (opts.resultadoClaude) buscaWeb = 'executada';
      V5 = await avaliarResultadosBusca(d.rede, resultados, nomes, dadosTit, redes, checagens, iso);
      evidencias.push({ ref: 'bw', fonte: 'busca_web', url: null, coletado_em: opts.resultadoClaude?.pesquisado_em ?? iso,
                        confiabilidade: provedor === 'claude' ? 'media' : 'alta',
                        payload: { provedor, consulta, urls: resultados.slice(0, 10).map((r) => r.url), observacao: opts.resultadoClaude?.observacao ?? null } });
      for (const [rede, url] of redes) {
        if ((rede === 'instagram' || rede === 'facebook' || rede === 'linkedin') && !contatos.some((c) => c.valor === url)) {
          contatos.push({ tipo: rede, valor: url, publico_comercial: true, evidencia_ref: 'bw' });
        }
      }
    }
  }

  if (checagens.length) {
    evidencias.push({ ref: 'http', fonte: 'http', url: null, coletado_em: iso, confiabilidade: 'alta', payload: { checagens } });
  }

  const verificacoes: Verificacoes = { ...base, V5, V6: montarV6() };
  const candidata: EmpresaCandidata = {
    nome_fantasia: nomePrincipal,
    razao_social: titulo(e.razao_social),
    cnpj: e.cnpj,
    segmento: seg?.id ?? null,
    cnae_principal: e.cnae_principal,
    porte: e.mei ? 'MEI' : e.porte,
    data_abertura: e.data_inicio,
    situacao_receita: e.situacao,
    endereco: { pais: 'BR', uf: e.uf, cidade: titulo(e.municipio_nome), bairro: titulo(e.bairro), logradouro: titulo(e.logradouro), cep: e.cep, lat, lng },
    identificadores,
    contatos,
    verificacoes,
    verificado_em: iso,
    evidencias,
  };
  return { candidata, prioridade: estimativa.lead_score, buscaWeb };
}

/** Avalia os links da busca web: redes (com nome compatível), diretórios ignorados, sites verificados por titularidade. */
async function avaliarResultadosBusca(
  rede: Rede, resultados: ResultadoBusca[], nomes: string[], dados: DadosTitularidade,
  redes: Map<string, string>, checagens: RegistroChecagem[], iso: string,
): Promise<ResultadoVerificacao> {
  let inconclusivo: ResultadoVerificacao | null = null;
  let sitesChecados = 0;
  for (const r of resultados.slice(0, 10)) {
    const tipo = classificarUrl(r.url);
    if (tipo.tipo === 'rede') {
      const perfil = decodeURIComponent(new URL(r.url).pathname.replace(/[/_.-]+/g, ' '));
      const compat = Math.max(...nomes.map((n) => Math.max(similaridadeNomes(n, r.titulo), similaridadeNomes(n, perfil))));
      if (compat >= 0.5 && !redes.has(tipo.rede)) redes.set(tipo.rede, r.url.split('?')[0]!);
      continue;
    }
    if (tipo.tipo !== 'candidato_site' || sitesChecados >= 4) continue;
    sitesChecados++;
    const s = await checarUrl(rede, r.url);
    checagens.push({ alvo: r.url, estado: s.estado, em: iso, ...('url' in s ? { url_final: s.url } : {}) });
    if (s.estado === 'redireciona_rede') continue;
    if (s.estado !== 'ativo') continue;
    const a = avaliarTitularidade(s, dados, 'busca');
    if (a.tipo === 'proprio') return { status: 'site_encontrado', url: a.url, acessivel: true };
    if (a.tipo === 'fraco' && !inconclusivo) inconclusivo = { status: 'inconclusivo', url: a.url, detalhe: a.detalhe };
  }
  return inconclusivo ?? { status: 'nada_encontrado' };
}
