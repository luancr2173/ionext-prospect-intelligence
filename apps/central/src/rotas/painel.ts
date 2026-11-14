import { SEGMENTOS } from '@ionext/dominio';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Sql } from '../db.ts';
import { canalLateral } from './empresas.ts';

/** Dias numa etapa até a oportunidade ser considerada parada (destaque no funil e na lista "Hoje"). */
export const PRAZO_ETAPA = { aprovada_para_contato: 3, abordada: 7, respondeu: 1, reuniao: 7, proposta: 10 } as const;

/** "Guara Ii" → "Guara II", "Setor De Industrias" → "Setor de Industrias". */
export function nomeBairro(nome: string): string {
  return nome
    .replace(/\b(?:I|Ii|Iii|Iv|Vi|Vii|Viii|Ix|Xi|Xii|Xiii|Xiv|Xv)\b/g, (r) => r.toUpperCase())
    .replace(/(?<=\S )(?:De|Da|Do|Das|Dos|E)\b/g, (r) => r.toLowerCase());
}

/** Rotas usadas pelo painel (e úteis para integrações): resumo, segmentos, buscas, status das oportunidades e dos motores. */
export function rotasPainel(app: FastifyInstance, sql: Sql) {
  app.get('/segmentos', async () => SEGMENTOS.map((s) => ({ id: s.id, nome: s.nome, cnaes: s.cnaes })));

  /**
   * Bairros de uma cidade com empresas ativas do segmento na base da Receita (para o seletor da nova busca).
   * "novas" = ainda não pesquisadas pelo motor (ou pesquisadas há mais de 30 dias).
   */
  app.get('/bairros', async (req, reply) => {
    const q = z.object({ uf: z.string().length(2), cidade: z.string().min(2).max(80), segmento: z.string().optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ erro: 'uf e cidade são obrigatórios' });
    const seg = q.data.segmento ? SEGMENTOS.find((s) => s.id === q.data.segmento) : undefined;
    const cidade = q.data.cidade.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const linhas = await sql<{ nome: string; total: number; novas: number }[]>`
      select initcap(lower(mode() within group (order by e.bairro))) as nome,
             count(*)::int as total,
             count(*) filter (where p.processado_em is null or p.processado_em < now() - interval '30 days')::int as novas
        from receita.estabelecimento e
        left join motor.empresa_processada p on p.cnpj = e.cnpj
       where e.uf = ${q.data.uf.toUpperCase()}
         and lower(extensions.unaccent(e.municipio_nome)) = ${cidade}
         and e.situacao = 'ATIVA'
         and coalesce(e.bairro_normalizado, '') <> ''
         ${seg ? sql`and e.cnae_principal = any(${seg.cnaes}::text[])` : sql``}
       group by e.bairro_normalizado
       order by total desc, nome
       limit 400`;
    return { bairros: linhas.map((l) => ({ ...l, nome: nomeBairro(l.nome) })) };
  });

  app.get('/painel/resumo', async () => {
    const [totais] = await sql`
      select (select count(*)::int from empresa) as empresas,
             (select count(*)::int from oportunidade where status not in ('descartada','perdida')) as oportunidades,
             (select count(*)::int from oportunidade where prioridade = 'alta' and status not in ('descartada','perdida')) as alta_prioridade,
             (select count(*)::int from oportunidade where status in ('nova','revisada')) as aguardando_revisao,
             (select count(*)::int from oportunidade where status = 'aprovada_para_contato') as aprovadas,
             (select count(*)::int from revisao_merge where status = 'pendente') as merges_pendentes`;
    const classificacoes = await sql`
      select classificacao, count(*)::int as total from presenca_digital group by 1 order by 2 desc`;
    const prioridades = await sql`
      select prioridade, count(*)::int as total from oportunidade
       where status not in ('descartada','perdida') group by 1`;
    const motores = await sql`select nome, dados, atualizado_em,
                                     extract(epoch from now() - atualizado_em)::int as segundos_atras
                                from motor_status order by nome`;
    // Funil acumulado: quem está numa etapa já passou pelas anteriores ("perdida" conta só como abordada).
    const [funil] = await sql`
      select count(*) filter (where status in ('abordada','respondeu','reuniao','proposta','ganha','perdida'))::int as abordadas,
             count(*) filter (where status in ('respondeu','reuniao','proposta','ganha'))::int as responderam,
             count(*) filter (where status in ('reuniao','proposta','ganha'))::int as reunioes,
             count(*) filter (where status in ('proposta','ganha'))::int as propostas,
             count(*) filter (where status = 'ganha')::int as ganhas,
             count(*) filter (where status = 'perdida')::int as perdidas
        from oportunidade`;
    // valores: em proposta agora e ganho no mês corrente (etapa_desde = quando virou "ganha")
    const [valores] = await sql`
      select coalesce(sum(proposta_valor) filter (where status = 'proposta'), 0)::float as em_proposta,
             coalesce(sum(proposta_valor) filter (where status = 'ganha'
               and etapa_desde >= date_trunc('month', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'), 0)::float as ganho_mes
        from oportunidade`;
    return { totais, classificacoes, prioridades, motores, funil, valores };
  });

  /**
   * Caixa de respostas: conversas cuja última mensagem é da empresa e que ninguém conferiu depois
   * (nem marcou como vista, nem registrou anotação). A que espera há mais tempo vem primeiro.
   */
  app.get('/painel/respostas', async () => {
    const itens = await sql`
      select o.id, o.status, o.lead_score, e.id as empresa_id, e.nome_fantasia, e.bairro, ch.canal, ch.telefone,
             ult.resumo as ultima_mensagem, ult.registrado_em as recebida_em,
             (select count(*)::int from interacao i
               where i.oportunidade_id = o.id and i.direcao = 'entrada'
                 and i.registrado_em > greatest(coalesce(o.respostas_vistas_em, '-infinity'), coalesce(hum.em, '-infinity'))) as novas
        from oportunidade o
        join empresa e on e.id = o.empresa_id
        join lateral (select i.resumo, i.registrado_em from interacao i
                       where i.oportunidade_id = o.id and i.direcao = 'entrada'
                       order by i.registrado_em desc limit 1) ult on true
        left join lateral (select max(i.registrado_em) as em from interacao i
                            where i.oportunidade_id = o.id and i.direcao = 'saida' and i.registrado_por <> 'neo') hum on true
        ${canalLateral(sql)}
       where o.status in ('abordada', 'respondeu', 'reuniao', 'proposta')
         and ult.registrado_em > coalesce(o.respostas_vistas_em, '-infinity')
         and ult.registrado_em > coalesce(hum.em, '-infinity')
       order by ult.registrado_em asc
       limit 30`;
    return { itens };
  });

  /** "Já vi": tira a conversa da caixa de respostas até chegar uma mensagem nova. */
  app.post('/oportunidades/:id/respostas-vistas', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [o] = await sql`update oportunidade set respostas_vistas_em = now() where id = ${id} returning id, respostas_vistas_em`;
    if (!o) return reply.code(404).send({ erro: 'oportunidade não encontrada' });
    return o;
  });

  /**
   * "O que fazer hoje", por urgência: reunião de hoje/amanhã (ou que já passou sem registro),
   * proposta com previsão de fechamento vencida, oportunidade parada além do prazo da etapa
   * e as melhores com WhatsApp ainda não aprovadas. Respostas ficam na caixa de respostas.
   */
  app.get('/painel/hoje', async () => {
    const itens = await sql`
      with base as (
        select o.id, o.status, o.lead_score, o.prioridade, o.etapa_desde, o.reuniao_em,
               o.previsao_fechamento::text as previsao_fechamento, o.proposta_valor::float as proposta_valor,
               floor(extract(epoch from now() - o.etapa_desde) / 86400)::int as dias_na_etapa,
               e.id as empresa_id, e.nome_fantasia, e.bairro, ch.canal, ch.telefone,
               case
                 when o.status = 'reuniao' and o.reuniao_em < ((now() at time zone 'America/Sao_Paulo')::date + 2) at time zone 'America/Sao_Paulo'
                   then 'reuniao'
                 when o.status = 'proposta' and o.previsao_fechamento <= (now() at time zone 'America/Sao_Paulo')::date
                   then 'fechamento'
                 when (o.status = 'aprovada_para_contato' and o.etapa_desde < now() - make_interval(days => ${PRAZO_ETAPA.aprovada_para_contato}))
                   or (o.status = 'abordada' and o.etapa_desde < now() - make_interval(days => ${PRAZO_ETAPA.abordada}))
                   or (o.status = 'respondeu' and o.etapa_desde < now() - make_interval(days => ${PRAZO_ETAPA.respondeu})
                       and not exists (select 1 from interacao i  -- quem está na caixa de respostas não se repete aqui
                                        where i.oportunidade_id = o.id and i.direcao = 'entrada'
                                          and i.registrado_em > coalesce(o.respostas_vistas_em, '-infinity')
                                          and not exists (select 1 from interacao s where s.oportunidade_id = o.id and s.direcao = 'saida'
                                                             and s.registrado_por <> 'neo' and s.registrado_em > i.registrado_em)))
                   or (o.status = 'reuniao' and o.reuniao_em is null and o.etapa_desde < now() - make_interval(days => ${PRAZO_ETAPA.reuniao}))
                   or (o.status = 'proposta' and o.previsao_fechamento is null and o.etapa_desde < now() - make_interval(days => ${PRAZO_ETAPA.proposta}))
                   then 'parada'
               end as motivo,
               case o.status
                 when 'aprovada_para_contato' then ${PRAZO_ETAPA.aprovada_para_contato}::int
                 when 'abordada' then ${PRAZO_ETAPA.abordada}::int
                 when 'respondeu' then ${PRAZO_ETAPA.respondeu}::int
                 when 'reuniao' then ${PRAZO_ETAPA.reuniao}::int
                 when 'proposta' then ${PRAZO_ETAPA.proposta}::int
               end as prazo
          from oportunidade o
          join empresa e on e.id = o.empresa_id
          ${canalLateral(sql)}
         where o.status in ('aprovada_para_contato', 'abordada', 'respondeu', 'reuniao', 'proposta'))
      select *, greatest(dias_na_etapa - coalesce(prazo, 0), 0) as dias_atraso
        from base where motivo is not null
       order by case motivo when 'reuniao' then 0 when 'fechamento' then 1 else 2 end,
                reuniao_em asc nulls last, previsao_fechamento asc nulls last,
                dias_na_etapa - coalesce(prazo, 0) desc
       limit 60`;
    const aprovar = await sql`
      select o.id, o.status, o.lead_score, o.prioridade, o.etapa_desde, 0 as dias_na_etapa, 0 as dias_atraso,
             e.id as empresa_id, e.nome_fantasia, e.bairro, ch.canal, ch.telefone, 'aprovar' as motivo
        from oportunidade o
        join empresa e on e.id = o.empresa_id
        ${canalLateral(sql)}
       where o.status in ('nova','revisada') and ch.canal = 'whatsapp' and o.prioridade = 'alta'
       order by o.lead_score desc nulls last limit 5`;
    return { prazos: PRAZO_ETAPA, itens: [...itens, ...aprovar] };
  });

  app.get('/buscas', async (req) => {
    const q = z.object({ status: z.string().optional(), limite: z.coerce.number().int().min(1).max(100).default(20) }).parse(req.query);
    const status = q.status ? q.status.split(',').map((x) => x.trim()) : null;
    return sql`
      select b.id, b.filtros, b.status, b.total_celulas, b.concluidas, b.criado_por, b.criado_em, b.concluida_em,
             (select count(*)::int from busca_resultado r where r.busca_id = b.id) as empresas
        from busca b
       ${status ? sql`where b.status = any(${status}::text[])` : sql``}
       order by b.criado_em desc limit ${q.limite}`;
  });

  /** Cancela uma busca que ainda está na fila ou rodando. O motor pula as empresas que faltam (o que já foi verificado fica). */
  app.post('/buscas/:id/cancelar', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [b] = await sql`update busca set status = 'cancelada', concluida_em = now()
                           where id = ${id} and status in ('planejada', 'executando', 'reprocessar')
                          returning id, status`;
    if (!b) return reply.code(409).send({ erro: 'só dá para cancelar busca na fila ou em andamento' });
    return b;
  });

  /**
   * Exclui a busca da lista. As empresas e oportunidades que ela encontrou continuam (só o vínculo
   * "encontrada por esta busca" some). Busca na fila ou rodando precisa ser cancelada antes.
   */
  app.delete('/buscas/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [b] = await sql`select status from busca where id = ${id}`;
    if (!b) return reply.code(404).send({ erro: 'busca não encontrada' });
    if (['planejada', 'executando', 'reprocessar'].includes(b.status)) {
      return reply.code(409).send({ erro: 'Essa busca ainda está rodando. Cancele antes de excluir.' });
    }
    await sql.begin(async (tx) => {
      await tx`delete from motor.busca_progresso where busca_id = ${id}`;
      await tx`delete from busca where id = ${id}`; // busca_resultado sai junto (on delete cascade); empresas ficam
    });
    return reply.code(204).send();
  });

  /** Pede ao Motor 01 para verificar de novo as empresas da busca (com as regras atuais). */
  app.post('/buscas/:id/reprocessar', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [b] = await sql`update busca set status = 'reprocessar' where id = ${id} and status <> 'reprocessar'
                          returning id, status`;
    if (!b) return reply.code(409).send({ erro: 'busca não encontrada ou já aguardando reprocessamento' });
    return b;
  });

  /**
   * Funil comercial (visão de CRM): oportunidades por etapa, com canal de contato,
   * último envio do Neo e última interação. "nova" e "revisada" formam a etapa "A revisar".
   */
  app.get('/pipeline', async (req) => {
    const q = z.object({
      canal: z.enum(['whatsapp', 'fixo', 'email', 'sem_contato']).optional(),
      por_etapa: z.coerce.number().int().min(1).max(200).default(40),
    }).parse(req.query);
    const valores = await sql`
      select status, coalesce(sum(proposta_valor), 0)::float as valor, count(proposta_valor)::int as com_valor
        from oportunidade where status in ('proposta', 'ganha') group by status`;
    const linhas = await sql`
      with ops as (
        select o.id, o.status, o.tipo, o.lead_score, o.prioridade, o.atualizado_em, o.etapa_desde,
               o.reuniao_em, o.proposta_valor::float as proposta_valor, o.previsao_fechamento::text as previsao_fechamento,
               floor(extract(epoch from now() - o.etapa_desde) / 86400)::int as dias_na_etapa,
               case when o.status in ('nova', 'revisada') then 'revisar' else o.status end as etapa,
               e.id as empresa_id, e.nome_fantasia, e.bairro, e.segmento, ch.canal, ch.telefone,
               (select max(i.registrado_em) from interacao i where i.oportunidade_id = o.id) as ultima_interacao,
               (select json_build_object('tipo', x.tipo, 'status', x.status, 'quando', coalesce(x.enviado_em, x.reservado_em))
                  from neo.envio x where x.oportunidade_id = o.id and not x.teste
                 order by x.reservado_em desc limit 1) as ultimo_envio
          from oportunidade o
          join empresa e on e.id = o.empresa_id
          ${canalLateral(sql)}
         where o.status in ('nova', 'revisada', 'aprovada_para_contato', 'abordada', 'respondeu', 'reuniao', 'proposta', 'ganha', 'perdida')
           ${q.canal ? sql`and ch.canal = ${q.canal}` : sql``}
      )
      select * from (
        select ops.*, row_number() over (partition by etapa order by lead_score desc nulls last, atualizado_em desc) as rn,
               count(*) over (partition by etapa)::int as total_etapa
          from ops) x
       where rn <= ${q.por_etapa}
       order by etapa, rn`;
    const etapas: Record<string, { total: number; itens: unknown[] }> = {};
    for (const { rn: _rn, total_etapa, ...r } of linhas) {
      const k = r.etapa as string;
      etapas[k] ??= { total: total_etapa as number, itens: [] };
      etapas[k].itens.push(r);
    }
    return { etapas, prazos: PRAZO_ETAPA, valores: Object.fromEntries(valores.map((v) => [v.status, { valor: v.valor, com_valor: v.com_valor }])) };
  });

  /** Mesmo status para várias oportunidades (ex.: aprovar 5 clínicas com WhatsApp de uma vez). */
  app.post('/oportunidades/status-em-lote', async (req) => {
    const p = z.object({
      ids: z.array(z.string().uuid()).min(1).max(200),
      status: z.enum(['revisada', 'aprovada_para_contato', 'descartada']),
    }).parse(req.body);
    const linhas = await sql`update oportunidade set status = ${p.status}, responsavel = ${req.cliente}
                              where id = any(${p.ids}::uuid[]) and status <> ${p.status}
                                and status in ('nova', 'revisada', 'aprovada_para_contato', 'descartada')
                              returning id`;
    return { atualizadas: linhas.length };
  });

  /** Dados do negócio: reunião, proposta (valor e solução) e previsão de fechamento. null apaga o campo. */
  app.patch('/oportunidades/:id/negocio', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = z.object({
      reuniao_em: z.string().datetime({ offset: true }).nullable().optional(),
      proposta_valor: z.number().min(0).max(9_999_999_999).nullable().optional(),
      proposta_solucao: z.string().trim().max(300).nullable().optional(),
      previsao_fechamento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    }).strict().parse(req.body);
    const campos = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, v === '' ? null : v]));
    if (Object.keys(campos).length === 0) return reply.code(400).send({ erro: 'nada para atualizar' });
    const [o] = await sql`update oportunidade set ${sql(campos)} where id = ${id}
                          returning id, status, reuniao_em, proposta_valor::float as proposta_valor, proposta_solucao, previsao_fechamento::text as previsao_fechamento`;
    if (!o) return reply.code(404).send({ erro: 'oportunidade não encontrada' });
    return o;
  });

  /** Mudança de status comercial feita por uma pessoa (aprovar para o Neo, descartar...). */
  app.patch('/oportunidades/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = z.object({
      status: z.enum(['nova', 'revisada', 'aprovada_para_contato', 'abordada', 'respondeu', 'reuniao', 'proposta', 'ganha', 'perdida', 'descartada', 'obsoleta']),
      observacao: z.string().max(1000).optional(),
    }).parse(req.body);
    const [o] = await sql`update oportunidade set status = ${p.status}, responsavel = ${req.cliente}
                          where id = ${id} returning id, status, empresa_id`;
    if (!o) return reply.code(404).send({ erro: 'oportunidade não encontrada' });
    if (p.observacao) {
      await sql`insert into interacao (oportunidade_id, canal, direcao, resumo, registrado_por)
                values (${id}, 'outro', 'saida', ${p.observacao}, ${req.cliente})`;
    }
    return o;
  });

  /** Sinal de vida e métricas de um motor (o painel mostra se está rodando, cota de busca web etc.). */
  app.put('/motores/:nome', async (req) => {
    const { nome } = z.object({ nome: z.string().regex(/^[a-z0-9-]{2,40}$/) }).parse(req.params);
    const dados = z.record(z.unknown()).parse(req.body);
    await sql`insert into motor_status (nome, dados) values (${nome}, ${sql.json(dados as never)})
              on conflict (nome) do update set dados = excluded.dados, atualizado_em = now()`;
    return { ok: true };
  });
}
