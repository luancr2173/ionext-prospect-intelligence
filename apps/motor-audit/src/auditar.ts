/** Uma auditoria: lê o site, roda o PageSpeed (celular e computador) e monta o diagnóstico do contrato. */
import type { DiagnosticoSite } from '@ionext/contratos';
import { diagnosticarSite, type MetricasPsi } from '@ionext/dominio';
import { VERSAO_MOTOR } from './config.ts';
import { lerSite, type Navegacao } from './crawler.ts';
import { ErroTemporario, type RodarPsi } from './psi.ts';

export interface PedidoAuditoria { empresa_id: string; url: string; tentativas: number }

export async function auditar(
  pedido: PedidoAuditoria,
  deps: { nav: Navegacao; psi: RodarPsi; tentativasPsi: number; agora?: () => Date },
): Promise<DiagnosticoSite> {
  const executada = (deps.agora ?? (() => new Date()))();
  const sinais = await lerSite(deps.nav, pedido.url);

  let mobile: MetricasPsi | null = null;
  let desktop: MetricasPsi | null = null;
  let psiErro: string | null = null;
  if (sinais.respondeu) {
    const alvo = sinais.url_final ?? pedido.url;
    try {
      mobile = await deps.psi(alvo, 'mobile');
      desktop = await deps.psi(alvo, 'desktop');
    } catch (e) {
      // sem cota / Google fora: tenta de novo mais tarde; na última tentativa segue só com o HTML
      if (e instanceof ErroTemporario && pedido.tentativas < deps.tentativasPsi) throw e;
      psiErro = (e as Error).message;
    }
  }

  const d = diagnosticarSite(sinais, { mobile, desktop }, executada.getFullYear());
  if (psiErro) {
    d.achados.push({
      codigo: 'sem_pagespeed', gravidade: 'info', titulo: 'Sem medição do PageSpeed',
      detalhe: `O PageSpeed não respondeu (${psiErro}); desempenho não entrou na classificação.`,
      pagina: sinais.url_final ?? pedido.url, evidencia: psiErro, recomendacao: 'Auditar de novo mais tarde.', servico: null,
    });
  }
  const { whatsapp, telefones, links_internos, formularios, paginas: _p, ...resto } = sinais;
  return {
    motor: VERSAO_MOTOR,
    empresa_id: pedido.empresa_id,
    url: pedido.url,
    url_final: sinais.url_final,
    executada_em: executada.toISOString(),
    psi: { mobile, desktop },
    paginas: sinais.paginas.slice(0, 50),
    achados: d.achados.slice(0, 40),
    pontos_positivos: d.pontos_positivos.slice(0, 20),
    resumo: d.resumo,
    servicos_recomendados: d.servicos_recomendados.slice(0, 10),
    classe: d.classe,
    sinais: {
      ...resto,
      whatsapp: whatsapp.slice(0, 5), telefones: telefones.slice(0, 5),
      links_quebrados: links_internos.filter((l) => l.status == null || l.status >= 400).slice(0, 15),
      links_checados: links_internos.length,
      formularios: formularios.slice(0, 6),
    },
  };
}
