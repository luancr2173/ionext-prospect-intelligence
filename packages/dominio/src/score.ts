import type { Classificacao } from './presenca.ts';

/**
 * Lead Score 0–100 (seção 6.3 da arquitetura).
 * Cada ponto exige evidência. Sem evidência, o critério vale 0 e aparece como "não verificado".
 */
export interface EntradaScore {
  classificacao: Classificacao;
  classeAuditoria?: 'B' | 'C' | 'D' | null;
  situacaoReceitaAtiva?: { valor: boolean; evidencia_id: string } | null;
  presencaEmFonteAberta?: { evidencia_id: string } | null;        // OSM, FSQ OS ou perfil verificado manualmente
  atividadeRecente?: { evidencia_id: string } | null;             // avaliação/post < 90 dias (registro manual)
  telefoneComercial?: { evidencia_id: string } | null;
  whatsappPublicado?: { evidencia_id: string } | null;
  avaliacoes?: { quantidade: number; evidencia_id: string } | null; // registro manual
  dataAbertura?: { data: string; evidencia_id: string } | null;
  porte?: { valor: 'MEI' | 'ME' | 'EPP' | 'DEMAIS'; evidencia_id: string } | null;
  pontosSegmento?: number | null;                                 // tabela segmento_prioritario
  hoje?: Date;
}

export interface LinhaScore {
  criterio: string;
  pontos: number;
  maximo: number;
  motivo: string;
  evidencia_ids: string[];
}

export interface ResultadoScore {
  lead_score: number;
  prioridade: 'alta' | 'media' | 'baixa';
  detalhe: LinhaScore[];
}

function pontosPresenca(c: Classificacao, classe?: 'B' | 'C' | 'D' | null): [number, string] {
  if (c === 'SEM_SITE') return [35, 'sem site próprio após verificação'];
  if (c === 'SOMENTE_REDES') return [30, 'usa só redes sociais/WhatsApp, sem site próprio'];
  if (c === 'PRESENCA_FRACA') return [25, 'site com problema grave (fora do ar ou classe B)'];
  if (c === 'SITE_EXISTENTE') {
    if (classe === 'B') return [25, 'site classe B na auditoria'];
    if (classe === 'C') return [15, 'site classe C na auditoria'];
    if (classe === 'D') return [5, 'site moderno (classe D)'];
    return [0, 'site existe, auditoria ainda não feita'];
  }
  return [0, 'verificação de presença pendente'];
}

function anosDesde(dataIso: string, hoje: Date): number {
  const d = new Date(dataIso);
  return (hoje.getTime() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
}

export function calcularLeadScore(e: EntradaScore): ResultadoScore {
  const hoje = e.hoje ?? new Date();
  const detalhe: LinhaScore[] = [];

  // 1. Presença digital (até 35)
  const [pp, mp] = pontosPresenca(e.classificacao, e.classeAuditoria);
  detalhe.push({ criterio: 'presenca_digital', pontos: pp, maximo: 35, motivo: mp, evidencia_ids: [] });

  // 2. Empresa ativa (até 20)
  let pa = 0;
  const ma: string[] = [];
  const ea: string[] = [];
  if (e.situacaoReceitaAtiva?.valor) { pa += 10; ma.push('situação ATIVA na Receita'); ea.push(e.situacaoReceitaAtiva.evidencia_id); }
  if (e.presencaEmFonteAberta) { pa += 5; ma.push('presente em fonte aberta/perfil verificado'); ea.push(e.presencaEmFonteAberta.evidencia_id); }
  if (e.atividadeRecente) { pa += 5; ma.push('atividade pública nos últimos 90 dias'); ea.push(e.atividadeRecente.evidencia_id); }
  detalhe.push({ criterio: 'empresa_ativa', pontos: pa, maximo: 20, motivo: ma.join('; ') || 'não verificado', evidencia_ids: ea });

  // 3. Canais de contato (até 20)
  let pc = 0;
  const mc: string[] = [];
  const ec: string[] = [];
  if (e.telefoneComercial) { pc += 10; mc.push('telefone comercial publicado'); ec.push(e.telefoneComercial.evidencia_id); }
  if (e.whatsappPublicado) { pc += 10; mc.push('WhatsApp publicado pela empresa'); ec.push(e.whatsappPublicado.evidencia_id); }
  detalhe.push({ criterio: 'contato', pontos: pc, maximo: 20, motivo: mc.join('; ') || 'nenhum canal comercial verificado', evidencia_ids: ec });

  // 4. Tração (até 15)
  let pt = 0;
  let mt = 'não verificado';
  const et: string[] = [];
  if (e.avaliacoes) {
    const q = e.avaliacoes.quantidade;
    pt = q >= 50 ? 15 : q >= 20 ? 10 : q >= 5 ? 5 : 0;
    mt = `${q} avaliações públicas (registro manual)`;
    et.push(e.avaliacoes.evidencia_id);
  } else if (e.dataAbertura && e.porte && (e.porte.valor === 'ME' || e.porte.valor === 'EPP')) {
    const anos = anosDesde(e.dataAbertura.data, hoje);
    if (anos >= 3) {
      pt = 5;
      mt = `${Math.floor(anos)} anos de operação, porte ${e.porte.valor}`;
      et.push(e.dataAbertura.evidencia_id, e.porte.evidencia_id);
    }
  }
  detalhe.push({ criterio: 'tracao', pontos: pt, maximo: 15, motivo: mt, evidencia_ids: et });

  // 5. Segmento prioritário (até 10)
  const ps = Math.max(0, Math.min(10, e.pontosSegmento ?? 0));
  detalhe.push({ criterio: 'segmento', pontos: ps, maximo: 10, motivo: ps ? 'segmento prioritário' : 'segmento sem prioridade definida', evidencia_ids: [] });

  const lead_score = detalhe.reduce((s, l) => s + l.pontos, 0);
  const prioridade = lead_score >= 70 ? 'alta' : lead_score >= 45 ? 'media' : 'baixa';
  return { lead_score, prioridade, detalhe };
}

/** Tipo de oportunidade a partir da presença/auditoria. null = ainda não há oportunidade definida. */
export function tipoOportunidade(c: Classificacao, classe?: 'B' | 'C' | 'D' | null): 'A' | 'B' | 'C' | 'D' | null {
  if (c === 'SEM_SITE' || c === 'SOMENTE_REDES') return 'A';
  if (c === 'PRESENCA_FRACA') return 'B';
  if (c === 'SITE_EXISTENTE') return classe ?? null;
  return null;
}
