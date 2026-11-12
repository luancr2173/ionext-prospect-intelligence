/**
 * Contratos v1 entre motores, Central e Neo (seção 7 da arquitetura).
 * Qualquer mudança incompatível vira v2; os motores declaram a versão em `motor`.
 */
import { z } from 'zod';

const iso = z.string().datetime({ offset: true });

export const FonteEvidencia = z.enum([
  'receita', 'osm', 'fsq_os', 'rdap', 'dns', 'http', 'busca_web', 'manual', 'pagespeed', 'crawler',
]);

export const Evidencia = z.object({
  ref: z.string().min(1).max(64),
  fonte: FonteEvidencia,
  url: z.string().url().nullable().optional(),
  coletado_em: iso,
  expira_em: iso.nullable().optional(),
  confiabilidade: z.enum(['alta', 'media', 'baixa']).default('media'),
  payload: z.record(z.unknown()).default({}),
});

export const ResultadoVerificacao = z.discriminatedUnion('status', [
  z.object({ status: z.literal('nao_executado') }),
  z.object({ status: z.literal('nao_aplicavel') }),
  z.object({ status: z.literal('erro'), detalhe: z.string() }),
  z.object({ status: z.literal('inconclusivo'), url: z.string().url(), detalhe: z.string() }),
  z.object({ status: z.literal('nada_encontrado') }),
  z.object({ status: z.literal('site_encontrado'), url: z.string().url(), acessivel: z.boolean() }),
]);

export const Verificacoes = z.object({
  V1: ResultadoVerificacao,
  V2: ResultadoVerificacao,
  V3: ResultadoVerificacao,
  V4: ResultadoVerificacao,
  V5: ResultadoVerificacao,
  V6: z.discriminatedUnion('status', [
    z.object({ status: z.literal('nao_executado') }),
    z.object({ status: z.literal('executado'), redes: z.array(z.string()) }),
  ]),
});

export const Contato = z.object({
  tipo: z.enum(['telefone', 'whatsapp', 'email', 'instagram', 'facebook', 'linkedin', 'outro']),
  valor: z.string().min(3),
  publico_comercial: z.boolean(),
  evidencia_ref: z.string(), // obrigatório: contato sem fonte não entra
});

export const Identificador = z.object({
  fonte: z.enum(['receita', 'osm', 'fsq_os', 'google_maps_link', 'instagram', 'facebook', 'dominio']),
  valor: z.string().min(1),
});

export const EmpresaCandidata = z
  .object({
    nome_fantasia: z.string().min(2),
    razao_social: z.string().nullable().optional(),
    cnpj: z.string().nullable().optional(),
    segmento: z.string().nullable().optional(),
    cnae_principal: z.string().regex(/^\d{7}$/).nullable().optional(),
    porte: z.enum(['MEI', 'ME', 'EPP', 'DEMAIS']).nullable().optional(),
    data_abertura: z.string().date().nullable().optional(),
    situacao_receita: z.string().nullable().optional(),
    endereco: z.object({
      pais: z.string().length(2).default('BR'),
      uf: z.string().length(2).nullable().optional(),
      cidade: z.string().nullable().optional(),
      bairro: z.string().nullable().optional(),
      logradouro: z.string().nullable().optional(),
      cep: z.string().nullable().optional(),
      lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(),
    }),
    identificadores: z.array(Identificador).default([]),
    contatos: z.array(Contato).default([]),
    /** A Central recalcula a classificação a partir destas verificações (regra única em @ionext/dominio). */
    verificacoes: Verificacoes.nullable().optional(),
    verificado_em: iso.nullable().optional(),
    evidencias: z.array(Evidencia).min(1),
  })
  .superRefine((c, ctx) => {
    const refs = new Set(c.evidencias.map((e) => e.ref));
    c.contatos.forEach((ct, i) => {
      if (!refs.has(ct.evidencia_ref)) {
        ctx.addIssue({ code: 'custom', path: ['contatos', i, 'evidencia_ref'], message: 'evidencia_ref não existe em evidencias' });
      }
    });
    if (c.verificacoes && !c.verificado_em) {
      ctx.addIssue({ code: 'custom', path: ['verificado_em'], message: 'obrigatório quando há verificacoes' });
    }
  });

export const IngestCandidatas = z.object({
  busca_id: z.string().uuid().nullable().optional(),
  motor: z.string().regex(/^[a-z0-9-]+@\d+\.\d+\.\d+$/),
  candidatas: z.array(EmpresaCandidata).min(1).max(200),
});

export const AcaoIngest = z.enum(['criada', 'mesclada', 'revisao_merge', 'bloqueada_opt_out', 'erro']);

export const RespostaIngest = z.object({
  resultados: z.array(z.object({
    indice: z.number().int(),
    empresa_id: z.string().uuid().nullable(),
    acao: AcaoIngest,
    classificacao: z.string().nullable(),
    lead_score: z.number().int().nullable(),
    avisos: z.array(z.string()),
  })),
});

/** Verificação manual feita no painel (substitui dados que viriam de APIs pagas). */
export const EvidenciaManual = z.object({
  tipo: z.enum(['perfil_google', 'avaliacoes', 'atividade_recente', 'link_bio', 'site_encontrado', 'observacao']),
  url: z.string().url().nullable().optional(),
  quantidade: z.number().int().min(0).nullable().optional(),   // avaliacoes
  nota: z.number().min(0).max(5).nullable().optional(),        // avaliacoes
  data: z.string().date().nullable().optional(),               // atividade_recente
  texto: z.string().max(2000).nullable().optional(),
}).superRefine((m, ctx) => {
  if (m.tipo === 'avaliacoes' && m.quantidade == null) ctx.addIssue({ code: 'custom', path: ['quantidade'], message: 'obrigatório para avaliacoes' });
  if (m.tipo === 'atividade_recente' && !m.data) ctx.addIssue({ code: 'custom', path: ['data'], message: 'obrigatório para atividade_recente' });
  if (['perfil_google', 'link_bio', 'site_encontrado'].includes(m.tipo) && !m.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'obrigatório' });
});

export const OptOut = z.object({
  chave: z.enum(['cnpj', 'telefone', 'email', 'dominio']),
  valor: z.string().min(3),
  motivo: z.string().max(500).nullable().optional(),
});

export type EmpresaCandidata = z.infer<typeof EmpresaCandidata>;
export type IngestCandidatas = z.infer<typeof IngestCandidatas>;
export type RespostaIngest = z.infer<typeof RespostaIngest>;
export type EvidenciaManual = z.infer<typeof EvidenciaManual>;
export type OptOut = z.infer<typeof OptOut>;
