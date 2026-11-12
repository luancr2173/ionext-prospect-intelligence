import {
  calcularLeadScore, tipoOportunidade, type Classificacao, type ResultadoScore,
} from '@ionext/dominio';
import type { Db } from '../db.ts';

const SERVICOS: Record<'A' | 'B' | 'C' | 'D', string[]> = {
  A: ['site institucional com CTA para WhatsApp', 'agente de IA para atendimento e qualificação'],
  B: ['reformulação do site', 'agente de IA para atendimento e qualificação'],
  C: ['otimização de desempenho, SEO e conversão', 'agente de IA para atendimento'],
  D: ['automação comercial e agente de IA'],
};

/**
 * Recalcula score e oportunidade de uma empresa a partir do que está no banco.
 * Só usa dados com evidência gravada. Não altera o status comercial de oportunidades existentes.
 */
export async function recalcularOportunidade(db: Db, empresaId: string, hoje = new Date()):
  Promise<{ classificacao: Classificacao | null; score: ResultadoScore | null; tipo: string | null }> {
  const [emp] = await db<{
    cnpj: string | null; segmento: string | null; situacao_receita: string | null;
    porte: 'MEI' | 'ME' | 'EPP' | 'DEMAIS' | null; data_abertura: string | null;
  }[]>`select cnpj, segmento, situacao_receita, porte, to_char(data_abertura, 'YYYY-MM-DD') as data_abertura
         from empresa where id = ${empresaId}`;
  if (!emp) throw new Error(`empresa ${empresaId} não encontrada`);

  const [pres] = await db<{ classificacao: Classificacao }[]>`
    select classificacao from presenca_digital where empresa_id = ${empresaId}`;
  if (!pres) return { classificacao: null, score: null, tipo: null };

  const [aud] = await db<{ classe: 'B' | 'C' | 'D' }[]>`
    select classe from auditoria where empresa_id = ${empresaId} order by executada_em desc limit 1`;

  const evid = await db<{ id: string; fonte: string; payload: Record<string, unknown>; coletado_em: Date }[]>`
    select id, fonte, payload, coletado_em from evidencia where empresa_id = ${empresaId} order by coletado_em desc`;

  const receita = evid.find((e) => e.fonte === 'receita');
  const fonteAberta = evid.find((e) =>
    e.fonte === 'osm' || e.fonte === 'fsq_os' || (e.fonte === 'manual' && e.payload.tipo === 'perfil_google'));
  const limite90 = new Date(hoje.getTime() - 90 * 24 * 3600 * 1000);
  const atividade = evid.find((e) =>
    e.fonte === 'manual' && e.payload.tipo === 'atividade_recente'
    && typeof e.payload.data === 'string' && new Date(e.payload.data) >= limite90);
  const avaliacoes = evid.find((e) => e.fonte === 'manual' && e.payload.tipo === 'avaliacoes');

  const contatos = await db<{ tipo: string; evidencia_id: string }[]>`
    select tipo, evidencia_id from contato
     where empresa_id = ${empresaId} and publico_comercial and evidencia_id is not null
       and tipo in ('telefone', 'whatsapp')`;

  const [seg] = emp.segmento
    ? await db<{ pontos: number }[]>`select pontos from segmento_prioritario where segmento = ${emp.segmento}`
    : [];

  const optout = await estaEmOptOut(db, empresaId);

  const score = calcularLeadScore({
    classificacao: pres.classificacao,
    classeAuditoria: aud?.classe ?? null,
    situacaoReceitaAtiva: receita && emp.situacao_receita
      ? { valor: emp.situacao_receita.toUpperCase() === 'ATIVA', evidencia_id: receita.id } : null,
    presencaEmFonteAberta: fonteAberta ? { evidencia_id: fonteAberta.id } : null,
    atividadeRecente: atividade ? { evidencia_id: atividade.id } : null,
    telefoneComercial: contatos.find((c) => c.tipo === 'telefone') ?? null,
    whatsappPublicado: contatos.find((c) => c.tipo === 'whatsapp') ?? null,
    avaliacoes: avaliacoes && typeof avaliacoes.payload.quantidade === 'number'
      ? { quantidade: avaliacoes.payload.quantidade, evidencia_id: avaliacoes.id } : null,
    dataAbertura: receita && emp.data_abertura ? { data: emp.data_abertura, evidencia_id: receita.id } : null,
    porte: receita && emp.porte ? { valor: emp.porte, evidencia_id: receita.id } : null,
    pontosSegmento: seg?.pontos ?? null,
    hoje,
  });

  const tipo = tipoOportunidade(pres.classificacao, aud?.classe ?? null);
  if (tipo) {
    await db`
      insert into oportunidade (empresa_id, tipo, servicos_sugeridos, lead_score, score_detalhe, prioridade, status)
      values (${empresaId}, ${tipo}, ${SERVICOS[tipo]}, ${score.lead_score}, ${db.json(score.detalhe as never)},
              ${score.prioridade}, ${optout ? 'descartada' : 'nova'})
      on conflict (empresa_id, tipo) do update
        set lead_score = excluded.lead_score,
            score_detalhe = excluded.score_detalhe,
            prioridade = excluded.prioridade,
            status = case when ${optout} then 'descartada' else oportunidade.status end`;
  }
  return { classificacao: pres.classificacao, score, tipo };
}

/** Empresa bate com algum registro de opt-out (CNPJ, telefone, e-mail ou domínio)? */
export async function estaEmOptOut(db: Db, empresaId: string): Promise<boolean> {
  const [r] = await db<{ bloqueada: boolean }[]>`
    select exists (
      select 1 from opt_out o
       where (o.chave = 'cnpj' and o.valor = (select cnpj from empresa where id = ${empresaId}))
          or (o.chave in ('telefone', 'email') and exists (
                select 1 from contato c where c.empresa_id = ${empresaId}
                   and c.valor_normalizado = o.valor
                   and (o.chave = 'email') = (c.tipo = 'email')))
          or (o.chave = 'dominio' and (
                exists (select 1 from contato c where c.empresa_id = ${empresaId}
                           and c.tipo = 'email' and split_part(c.valor_normalizado, '@', 2) = o.valor)
                or exists (select 1 from presenca_digital p where p.empresa_id = ${empresaId}
                           and p.url_site ilike '%' || o.valor || '%')))
    ) as bloqueada`;
  return r?.bloqueada ?? false;
}
