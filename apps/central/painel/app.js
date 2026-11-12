/* IONEXT Prospect Intelligence — painel (sem build, sem dependências).
 * Todo texto vindo da API entra via textContent (nada de innerHTML com dados). */
'use strict';

// ------------------------------------------------------------------ utilidades
const $app = document.getElementById('app');

function h(tag, props, ...filhos) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') throw new Error('html proibido');
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos.flat(Infinity)) {
    if (f == null || f === false) continue;
    el.append(f instanceof Node ? f : document.createTextNode(String(f)));
  }
  return el;
}

function aviso(texto) {
  const el = document.getElementById('aviso');
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => { el.hidden = true; }, 3500);
}

async function api(metodo, caminho, corpo) {
  const r = await fetch(caminho, {
    method: metodo,
    credentials: 'same-origin',
    headers: { ...(corpo ? { 'content-type': 'application/json' } : {}), 'x-painel': '1' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (r.status === 401 && caminho.startsWith('/v1/')) { telaLogin(); throw new Error('sessão expirada'); }
  const texto = await r.text();
  const dados = texto ? JSON.parse(texto) : null;
  if (!r.ok) throw new Error((dados && dados.erro) || `HTTP ${r.status}`);
  return dados;
}

const linkSeguro = (url, texto) => /^https?:\/\//i.test(url || '')
  ? h('a', { class: 'link', href: url, target: '_blank', rel: 'noopener noreferrer' }, texto || url)
  : (texto || url || '—');

const quando = (iso) => iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const cnpjFmt = (c) => c && c.length === 14 ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : (c || '—');

// ------------------------------------------------------------------ vocabulário
const CLASSES = {
  SEM_SITE: 'Sem site',
  SOMENTE_REDES: 'Só redes sociais',
  PRESENCA_FRACA: 'Presença fraca',
  SITE_EXISTENTE: 'Tem site',
  PENDENTE: 'Verificação pendente',
};
const STATUS = {
  nova: 'Nova', revisada: 'Revisada', aprovada_para_contato: 'Aprovada para o Neo', abordada: 'Abordada',
  respondeu: 'Respondeu', reuniao: 'Reunião', proposta: 'Proposta', ganha: 'Ganha', perdida: 'Perdida', descartada: 'Descartada',
};
const STATUS_BUSCA = { planejada: 'Na fila', executando: 'Em andamento', concluida: 'Concluída', falhou: 'Falhou', cancelada: 'Cancelada', reprocessar: 'Reprocessando' };
const VERIF = {
  V1: 'Perfil verificado manualmente', V2: 'OpenStreetMap', V3: 'Domínio do e-mail', V4: 'Domínios pelo nome', V5: 'Busca web', V6: 'Redes sociais',
};
const RESULTADO = {
  nao_executado: 'não executado', nao_aplicavel: 'não se aplica', erro: 'erro', inconclusivo: 'inconclusivo',
  nada_encontrado: 'nada encontrado', site_encontrado: 'site encontrado', executado: 'verificado',
};
const CRITERIO = { presenca_digital: 'Presença digital', empresa_ativa: 'Empresa ativa', contato: 'Contato', tracao: 'Tração', segmento: 'Segmento' };
const TIPO_OP = { A: 'Primeiro site', B: 'Reformulação', C: 'Melhorias', D: 'Automação' };
let SEGMENTOS = [];
const nomeSegmento = (id) => (SEGMENTOS.find((s) => s.id === id) || {}).nome || id || '—';

const etiquetaClasse = (c) => c
  ? h('span', { class: 'etiqueta' }, h('span', { class: `bolinha c-${c}` }), CLASSES[c] || c)
  : h('span', { class: 'etiqueta e-baixa' }, 'Sem verificação');
const etiquetaPrioridade = (p) => p ? h('span', { class: `etiqueta e-${p}` }, { alta: 'Alta', media: 'Média', baixa: 'Baixa' }[p]) : null;

// ------------------------------------------------------------------ estado do motor (topo)
async function atualizarMotor() {
  const el = document.getElementById('motor');
  try {
    const r = await api('GET', '/v1/painel/resumo');
    const m = (r.motores || []).find((x) => x.nome === 'motor-prospecting');
    const online = m && m.segundos_atras < 90;
    el.className = `motor ${online ? 'online' : 'offline'}`;
    const partes = [online ? 'Motor 01 rodando' : 'Motor 01 parado'];
    if (m) {
      for (const p of m.dados.busca_web || []) partes.push(`${p.provedor} ${p.usadas}/${p.limite}`);
      const fila = m.dados.fila_claude || {};
      if (fila.pendente) partes.push(`fila Claude ${fila.pendente}`);
    }
    el.querySelector('.motor-texto').textContent = partes.join(' · ');
    return r;
  } catch { el.className = 'motor offline'; return null; }
}

// ------------------------------------------------------------------ telas
function telaLogin() {
  document.getElementById('topo').hidden = true;
  const erro = h('div', { class: 'erro' });
  const senha = h('input', { type: 'password', placeholder: 'Senha do painel', autocomplete: 'current-password', required: true });
  const form = h('form', {
    onsubmit: async (ev) => {
      ev.preventDefault();
      erro.textContent = '';
      try {
        await api('POST', '/painel/login', { senha: senha.value });
        iniciar();
      } catch (e) { erro.textContent = e.message; senha.select(); }
    },
  }, senha, erro, h('button', { class: 'botao primario', type: 'submit' }, 'Entrar'));
  $app.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'cartao' },
    h('span', { class: 'marca-ionext' }, 'ionext'),
    h('div', { class: 'legenda' }, 'Prospect Intelligence'),
    form)));
  senha.focus();
}

async function telaInicio() {
  const [resumo, buscas] = await Promise.all([atualizarMotor(), api('GET', '/v1/buscas?limite=15')]);
  if (!resumo) return;
  const t = resumo.totais;
  const total = resumo.classificacoes.reduce((s, c) => s + c.total, 0);

  const kpi = (rotulo, valor, nota, destaque) => h('div', { class: 'cartao compacto' },
    h('div', { class: 'kpi-rotulo' }, rotulo),
    h('div', { class: `kpi-valor${destaque ? ' destaque' : ''}` }, valor.toLocaleString('pt-BR')),
    nota && h('div', { class: 'kpi-nota' }, nota));

  const ordem = ['SEM_SITE', 'SOMENTE_REDES', 'PRESENCA_FRACA', 'PENDENTE', 'SITE_EXISTENTE'];
  const porClasse = Object.fromEntries(resumo.classificacoes.map((c) => [c.classificacao, c.total]));

  $app.replaceChildren(
    h('div', { class: 'cabecalho' }, h('div', {},
      h('h1', {}, 'Visão geral'),
      h('p', { class: 'legenda' }, 'Empresas encontradas, verificadas e prontas para virar conversa.'))),

    h('div', { class: 'grade grade-4' },
      kpi('Empresas analisadas', t.empresas),
      kpi('Oportunidades abertas', t.oportunidades, 'sem site, só redes ou site fraco', true),
      kpi('Alta prioridade', t.alta_prioridade, 'score 70 ou mais'),
      kpi('Aguardando sua revisão', t.aguardando_revisao, t.aprovadas ? `${t.aprovadas} já aprovadas para o Neo` : 'nenhuma aprovada ainda')),

    h('div', { class: 'cartao', style: { marginTop: '16px' } },
      h('h2', {}, 'Presença digital'),
      total === 0 ? h('div', { class: 'legenda' }, 'Nenhuma empresa verificada ainda. Crie uma busca abaixo.') : [
        h('div', { class: 'barra' }, ordem.filter((c) => porClasse[c]).map((c) =>
          h('span', { class: `c-${c}`, style: { width: `${(porClasse[c] / total) * 100}%` }, title: `${CLASSES[c]}: ${porClasse[c]}` }))),
        h('div', { class: 'legendas' }, ordem.filter((c) => porClasse[c]).map((c) =>
          h('a', { href: `#/empresas?classificacao=${c}` }, h('span', { class: `bolinha c-${c}` }), CLASSES[c], h('b', {}, porClasse[c])))),
      ]),

    h('div', { class: 'grade grade-2', style: { marginTop: '16px' } },
      h('div', { class: 'cartao' }, h('h2', {}, 'Buscas'), listaBuscas(buscas)),
      formNovaBusca()),
  );
}

function listaBuscas(buscas) {
  if (!buscas.length) return h('div', { class: 'legenda' }, 'Nenhuma busca ainda.');
  return h('div', { class: 'lista' }, buscas.map((b) => {
    const f = b.filtros || {};
    const pct = b.total_celulas ? Math.min(100, Math.round((b.concluidas / b.total_celulas) * 100)) : (b.status === 'concluida' ? 100 : 0);
    const andando = b.status === 'executando' || b.status === 'planejada' || b.status === 'reprocessar';
    return h('div', { class: 'item' },
      h('div', {},
        h('div', { class: 'item-titulo' }, nomeSegmento(f.segmento)),
        h('div', { class: 'item-sub' }, [(f.bairros || []).join(', ') || f.cidade, `${b.empresas} empresas`, quando(b.criado_em)].filter(Boolean).join(' · ')),
        andando && h('div', { class: 'progresso' }, h('span', { style: { width: `${pct}%` } }))),
      h('div', { class: 'acoes' },
        h('span', { class: `etiqueta ${b.status === 'concluida' ? 'e-ok' : b.status === 'falhou' ? 'e-erro' : andando ? 'e-alerta' : ''}` },
          STATUS_BUSCA[b.status] || b.status, andando && b.total_celulas ? ` ${b.concluidas}/${b.total_celulas}` : ''),
        h('a', { class: 'botao pequeno', href: `#/empresas?busca=${b.id}` }, 'Ver empresas'),
        b.status === 'concluida' && h('button', {
          class: 'botao pequeno', type: 'button', title: 'Verifica de novo com as regras atuais (a busca web usa o cache)',
          onclick: async (ev) => {
            ev.target.disabled = true;
            try { await api('POST', `/v1/buscas/${b.id}/reprocessar`); aviso('Reprocessamento pedido. O motor começa em até 20 s.'); render(); }
            catch (e) { aviso(e.message); ev.target.disabled = false; }
          },
        }, 'Reprocessar')));
  }));
}

function formNovaBusca() {
  const segmento = h('select', {}, SEGMENTOS.map((s) => h('option', { value: s.id }, s.nome)));
  segmento.value = 'clinica_odontologica';
  const bairros = h('input', { value: 'Asa Norte, Taguatinga, Aguas Claras', placeholder: 'Asa Norte, Taguatinga…' });
  const quantidade = h('input', { type: 'number', min: 1, max: 5000, value: 100 });
  const cidade = h('input', { value: 'Brasília' });
  const uf = h('input', { value: 'DF', maxlength: 2 });
  const botao = h('button', { class: 'botao azul', type: 'submit' }, 'Iniciar busca');
  return h('form', {
    class: 'cartao',
    onsubmit: async (ev) => {
      ev.preventDefault();
      botao.disabled = true;
      try {
        await api('POST', '/v1/buscas', {
          segmento: segmento.value, uf: uf.value.trim().toUpperCase(), cidade: cidade.value.trim(),
          bairros: bairros.value.split(',').map((x) => x.trim()).filter(Boolean),
          quantidade_desejada: Number(quantidade.value),
        });
        aviso('Busca criada. O motor começa em até 20 s.');
        render();
      } catch (e) { aviso(e.message); } finally { botao.disabled = false; }
    },
  },
    h('h2', {}, 'Nova busca'),
    h('div', { class: 'pilha' },
      h('div', { class: 'campo' }, h('label', {}, 'Segmento'), segmento),
      h('div', { class: 'campo' }, h('label', {}, 'Bairros'), bairros, h('span', { class: 'ajuda' }, 'Separados por vírgula. Vazio = cidade inteira.')),
      h('div', { class: 'grade', style: { gridTemplateColumns: '1fr 2fr 70px' } },
        h('div', { class: 'campo' }, h('label', {}, 'Quantidade'), quantidade),
        h('div', { class: 'campo' }, h('label', {}, 'Cidade'), cidade),
        h('div', { class: 'campo' }, h('label', {}, 'UF'), uf)),
      h('div', {}, botao)));
}

async function telaEmpresas(params) {
  const filtros = {
    q: params.get('q') || '', classificacao: params.get('classificacao') || '', prioridade: params.get('prioridade') || '',
    status: params.get('status') || '', busca: params.get('busca') || '', pagina: Number(params.get('pagina') || 1),
  };
  const query = new URLSearchParams(Object.entries(filtros).filter(([, v]) => v).map(([k, v]) => [k, String(v)]));
  query.set('limite', '50');
  const r = await api('GET', `/v1/empresas?${query}`);
  atualizarMotor();

  const navegar = (mudar) => {
    const p = new URLSearchParams(Object.entries({ ...filtros, pagina: 1, ...mudar }).filter(([, v]) => v).map(([k, v]) => [k, String(v)]));
    location.hash = `#/empresas?${p}`;
  };
  const opcoes = (mapa, vazio) => [h('option', { value: '' }, vazio), ...Object.entries(mapa).map(([v, t]) => h('option', { value: v }, t))];
  const sel = (nome, mapa, vazio) => { const s = h('select', { onchange: () => navegar({ [nome]: s.value }) }, opcoes(mapa, vazio)); s.value = filtros[nome]; return s; };
  const busca = h('input', { placeholder: 'Buscar por nome ou CNPJ', value: filtros.q });
  busca.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') navegar({ q: busca.value.trim() }); });

  const paginas = Math.max(1, Math.ceil(r.total / 50));
  $app.replaceChildren(
    h('div', { class: 'cabecalho' }, h('div', {},
      h('h1', {}, 'Empresas'),
      h('p', { class: 'legenda' }, `${r.total.toLocaleString('pt-BR')} encontradas${filtros.busca ? ' nesta busca' : ''}, ordenadas por score.`)),
      filtros.busca && h('a', { class: 'botao pequeno', href: '#/empresas' }, 'Ver todas')),
    h('div', { class: 'filtros' },
      busca,
      sel('classificacao', CLASSES, 'Toda presença'),
      sel('prioridade', { alta: 'Alta', media: 'Média', baixa: 'Baixa' }, 'Toda prioridade'),
      sel('status', STATUS, 'Todo status')),
    h('div', { class: 'cartao', style: { padding: '14px 10px' } },
      r.itens.length === 0 ? h('div', { class: 'vazio' }, 'Nenhuma empresa com esses filtros.') :
        h('table', { class: 'tabela' },
          h('thead', {}, h('tr', {}, ['Empresa', 'Bairro', 'Presença', 'Prioridade', 'Status'].map((c) => h('th', {}, c)), h('th', { class: 'num' }, 'Score'))),
          h('tbody', {}, r.itens.map((e) => h('tr', { onclick: () => { location.hash = `#/empresa/${e.id}`; } },
            h('td', {}, h('div', { class: 'item-titulo' }, e.nome_fantasia), h('div', { class: 'item-sub' }, nomeSegmento(e.segmento))),
            h('td', { class: 'item-sub' }, e.bairro || '—'),
            h('td', {}, etiquetaClasse(e.classificacao)),
            h('td', {}, etiquetaPrioridade(e.prioridade) || h('span', { class: 'item-sub' }, '—')),
            h('td', { class: 'item-sub' }, STATUS[e.status] || '—'),
            h('td', { class: 'num score' }, e.lead_score ?? '—')))))),
    h('div', { class: 'paginacao' },
      h('button', { class: 'botao pequeno', disabled: filtros.pagina <= 1, onclick: () => navegar({ ...filtros, pagina: filtros.pagina - 1 }) }, 'Anterior'),
      h('span', {}, `Página ${filtros.pagina} de ${paginas}`),
      h('button', { class: 'botao pequeno', disabled: filtros.pagina >= paginas, onclick: () => navegar({ ...filtros, pagina: filtros.pagina + 1 }) }, 'Próxima')),
  );
}

async function telaEmpresa(id) {
  const f = await api('GET', `/v1/empresas/${id}`);
  const e = f.empresa;
  const p = f.presenca_digital;
  const ops = f.oportunidades.filter((o) => o.status !== 'descartada').sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0));
  const op = ops[0] || f.oportunidades[0] || null;
  const verif = p ? p.verificacoes : null;

  const statusVerif = (r) => {
    if (!r) return '—';
    const txt = RESULTADO[r.status] || r.status;
    const cls = r.status === 'site_encontrado' ? 'e-alta' : r.status === 'erro' ? 'e-erro' : r.status === 'inconclusivo' ? 'e-alerta' : '';
    return h('span', { class: `etiqueta ${cls}` }, r.redes && r.redes.length ? `${txt}: ${r.redes.join(', ')}` : txt);
  };

  const acoes = op ? cartaoAcoes(op, e) : h('div', { class: 'cartao' }, h('h2', {}, 'Ações'),
    h('p', { class: 'legenda' }, p && p.classificacao === 'PENDENTE'
      ? 'A verificação está pendente: registre o que você encontrou em “Verificação manual” para concluir.'
      : 'Esta empresa ainda não tem uma oportunidade (por exemplo: tem site e ainda não passou pela auditoria).'));

  $app.replaceChildren(
    h('button', { class: 'voltar botao-texto', type: 'button', onclick: () => history.back() }, '← Voltar'),
    h('div', { class: 'cabecalho' }, h('div', {},
      h('h1', {}, e.nome_fantasia),
      h('div', { class: 'legenda' }, [e.razao_social, e.cnpj && `CNPJ ${cnpjFmt(e.cnpj)}`, [e.bairro, e.cidade, e.uf].filter(Boolean).join(', ')].filter(Boolean).join(' · ')),
      h('div', { class: 'titulo-ficha' },
        etiquetaClasse(p && p.classificacao),
        op && etiquetaPrioridade(op.prioridade),
        op && h('span', { class: 'etiqueta' }, `Score ${op.lead_score}`),
        op && h('span', { class: 'etiqueta' }, `Oportunidade ${op.tipo}: ${TIPO_OP[op.tipo]}`),
        p && h('span', { class: 'etiqueta' }, `Confiabilidade ${p.confiabilidade}`)))),

    h('div', { class: 'grade grade-2' },
      h('div', { class: 'pilha' },
        h('div', { class: 'cartao' },
          h('h2', {}, 'Presença digital'),
          p && p.url_site && h('dl', { class: 'dados' }, h('dt', {}, 'Site'), h('dd', {}, linkSeguro(p.url_site))),
          verif ? ['V1', 'V2', 'V3', 'V4', 'V5', 'V6'].map((k) => h('div', { class: 'verif' },
            h('code', {}, k), h('span', {}, VERIF[k], verif[k] && verif[k].url ? [' · ', linkSeguro(verif[k].url, 'abrir')] : ''), statusVerif(verif[k]))) :
            h('p', { class: 'legenda' }, 'Ainda não verificada.'),
          verif && verif.motivos && h('ul', { class: 'motivos' }, verif.motivos.map((m) => h('li', {}, m.replace(/\bV([1-6])\b/g, (_, n) => VERIF[`V${n}`]))))),

        op && h('div', { class: 'cartao' },
          h('h2', {}, `Lead Score · ${op.lead_score}`),
          (op.score_detalhe || []).map((l) => h('div', { class: 'linha-score' },
            h('span', {}, CRITERIO[l.criterio] || l.criterio),
            h('div', { class: 'trilho' }, h('span', { style: { width: `${(l.pontos / l.maximo) * 100}%` } })),
            h('span', { class: 'num' }, `${l.pontos}/${l.maximo}`),
            h('span', { class: 'motivo' }, l.motivo)))),

        h('div', { class: 'cartao' },
          h('h2', {}, 'Fontes e evidências'),
          f.validacao.evidencias.map((ev) => h('div', { class: 'evid' },
            h('span', { class: 'etiqueta fonte' }, { receita: 'Receita', osm: 'OpenStreetMap', fsq_os: 'Foursquare', http: 'Site/DNS', dns: 'DNS', busca_web: 'Busca web', manual: 'Manual', pagespeed: 'PageSpeed', crawler: 'Crawler', rdap: 'RDAP' }[ev.fonte] || ev.fonte),
            h('div', {},
              h('div', {}, ev.url ? linkSeguro(ev.url) : resumoEvidencia(ev)),
              h('div', { class: 'item-sub' }, `${quando(ev.coletado_em)} · confiabilidade ${ev.confiabilidade}${ev.operador ? ` · por ${ev.operador}` : ''}`)))))),

      h('div', { class: 'pilha' },
        acoes,
        h('div', { class: 'cartao' },
          h('h2', {}, 'Contatos'),
          f.contatos.length === 0 ? h('p', { class: 'legenda' }, 'Nenhum contato encontrado.') :
            f.contatos.map((c) => h('div', { class: 'contato' },
              h('div', {}, h('div', {}, /^https?:/.test(c.valor) ? linkSeguro(c.valor) : c.valor), h('small', {}, `${c.tipo} · fonte: ${c.fonte || '—'}`)),
              h('span', { class: `etiqueta ${c.publico_comercial ? 'e-ok' : 'e-baixa'}`, title: c.publico_comercial ? '' : 'Pode ser contato pessoal (ex.: MEI). Não usar para abordagem sem confirmar.' },
                c.publico_comercial ? 'comercial' : 'não confirmar'))),
          f.validacao.nao_encontrado.length > 0 && h('p', { class: 'ajuda', style: { marginTop: '12px' } },
            `Não encontrado: ${f.validacao.nao_encontrado.map((x) => x.replace('contato.', '')).join(', ')}`)),
        formVerificacaoManual(e.id))));
}

function resumoEvidencia(ev) {
  const p = ev.payload || {};
  if (ev.fonte === 'receita') return `Base CNPJ ${p.referencia || ''} · CNAE ${p.cnae || ''} · ${p.situacao || ''}${p.porte ? ` · ${p.porte}` : ''}`;
  if (ev.fonte === 'busca_web') return `Busca: ${p.consulta || ''} · ${String(p.provedor || '').replace('cache:', '')} · ${(p.urls || []).length} links avaliados`;
  if (ev.fonte === 'http') return `${(p.checagens || []).length} domínios/sites testados: ${(p.checagens || []).map((c) => `${c.alvo} (${c.estado})`).join(', ')}`;
  if (ev.fonte === 'manual') return `Verificação manual: ${p.tipo || ''}${p.quantidade != null ? ` · ${p.quantidade} avaliações` : ''}${p.nota ? ` · nota ${p.nota}` : ''}${p.texto ? ` · ${p.texto}` : ''}`;
  return JSON.stringify(p).slice(0, 160);
}

function cartaoAcoes(op, empresa) {
  const area = h('div');
  const mudar = async (status, msg) => {
    try { await api('PATCH', `/v1/oportunidades/${op.id}`, { status }); aviso(msg); render(); } catch (e) { aviso(e.message); }
  };
  const confirmarOptOut = () => {
    const tel = empresa.cnpj;
    area.replaceChildren(h('div', { class: 'confirmar' },
      h('p', { style: { margin: '0 0 10px' } }, 'Registrar que esta empresa não quer ser contatada? Ela sai de todas as filas e não volta em buscas futuras.'),
      h('div', { class: 'acoes' },
        h('button', { class: 'botao perigo pequeno', onclick: async () => {
          try { await api('POST', '/v1/opt-out', { chave: 'cnpj', valor: tel, motivo: 'registrado no painel' }); aviso('Opt-out registrado.'); render(); }
          catch (e) { aviso(e.message); }
        } }, 'Confirmar opt-out'),
        h('button', { class: 'botao pequeno', onclick: () => area.replaceChildren() }, 'Cancelar'))));
  };
  return h('div', { class: 'cartao' },
    h('h2', {}, 'Ações'),
    h('p', { class: 'legenda', style: { marginTop: '-6px', marginBottom: '14px' } }, `Status: ${STATUS[op.status] || op.status}`,
      op.servicos_sugeridos && op.servicos_sugeridos.length ? ` · Sugestão: ${op.servicos_sugeridos.join(', ')}` : ''),
    h('div', { class: 'acoes' },
      op.status !== 'aprovada_para_contato' && h('button', { class: 'botao azul', onclick: () => mudar('aprovada_para_contato', 'Aprovada para o Neo.') }, 'Aprovar para o Neo'),
      op.status === 'nova' && h('button', { class: 'botao', onclick: () => mudar('revisada', 'Marcada como revisada.') }, 'Marcar revisada'),
      op.status !== 'descartada' && h('button', { class: 'botao', onclick: () => mudar('descartada', 'Descartada.') }, 'Descartar'),
      op.status === 'descartada' && h('button', { class: 'botao', onclick: () => mudar('nova', 'Reaberta.') }, 'Reabrir'),
      empresa.cnpj && h('button', { class: 'botao perigo', onclick: confirmarOptOut }, 'Não contatar')),
    h('p', { class: 'ajuda', style: { marginTop: '12px' } }, 'Nada é enviado automaticamente: o Neo só lê empresas aprovadas aqui.'),
    area);
}

function formVerificacaoManual(empresaId) {
  const tipo = h('select', {},
    h('option', { value: 'perfil_google' }, 'Perfil no Google Maps'),
    h('option', { value: 'avaliacoes' }, 'Avaliações (quantidade e nota)'),
    h('option', { value: 'atividade_recente' }, 'Atividade recente (post/avaliação)'),
    h('option', { value: 'link_bio' }, 'Link na bio do Instagram'),
    h('option', { value: 'site_encontrado' }, 'Encontrei o site da empresa'),
    h('option', { value: 'observacao' }, 'Observação'));
  const url = h('input', { type: 'url', placeholder: 'https://…' });
  const quantidade = h('input', { type: 'number', min: 0, placeholder: 'ex.: 84' });
  const nota = h('input', { type: 'number', min: 0, max: 5, step: '0.1', placeholder: 'ex.: 4.8' });
  const data = h('input', { type: 'date' });
  const texto = h('textarea', { rows: 2, placeholder: 'Detalhes (opcional)' });
  const cQtd = h('div', { class: 'campo' }, h('label', {}, 'Avaliações'), quantidade);
  const cNota = h('div', { class: 'campo' }, h('label', {}, 'Nota'), nota);
  const cData = h('div', { class: 'campo' }, h('label', {}, 'Data'), data);
  const cUrl = h('div', { class: 'campo' }, h('label', {}, 'Link'), url);
  const ajustar = () => {
    const t = tipo.value;
    cQtd.hidden = cNota.hidden = t !== 'avaliacoes';
    cData.hidden = t !== 'atividade_recente';
    cUrl.hidden = t === 'observacao';
  };
  tipo.addEventListener('change', ajustar);
  ajustar();
  const botao = h('button', { class: 'botao primario', type: 'submit' }, 'Registrar');
  return h('form', {
    class: 'cartao',
    onsubmit: async (ev) => {
      ev.preventDefault();
      botao.disabled = true;
      const corpo = { tipo: tipo.value };
      if (!cUrl.hidden && url.value) corpo.url = url.value.trim();
      if (!cQtd.hidden && quantidade.value) corpo.quantidade = Number(quantidade.value);
      if (!cNota.hidden && nota.value) corpo.nota = Number(nota.value);
      if (!cData.hidden && data.value) corpo.data = data.value;
      if (texto.value.trim()) corpo.texto = texto.value.trim();
      try {
        const r = await api('POST', `/v1/empresas/${empresaId}/evidencias-manuais`, corpo);
        aviso(`Registrado. Score agora: ${r.lead_score ?? '—'}`);
        render();
      } catch (e) { aviso(e.message); } finally { botao.disabled = false; }
    },
  },
    h('h2', {}, 'Verificação manual'),
    h('p', { class: 'legenda', style: { marginTop: '-6px', marginBottom: '14px' } }, 'Abra o Google Maps ou o Instagram no navegador e registre aqui o que viu. Isso sobe a confiabilidade e o score.'),
    h('div', { class: 'pilha' },
      h('div', { class: 'campo' }, h('label', {}, 'O que você verificou'), tipo),
      cUrl,
      h('div', { class: 'grade', style: { gridTemplateColumns: '1fr 1fr' } }, cQtd, cNota),
      cData,
      h('div', { class: 'campo' }, h('label', {}, 'Observação'), texto),
      h('div', {}, botao)));
}

// ------------------------------------------------------------------ roteamento
let timerAtualizacao = null;

async function render() {
  clearInterval(timerAtualizacao);
  const [caminho, qs] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(qs || '');
  document.querySelectorAll('.abas a').forEach((a) => a.classList.toggle('ativa',
    (a.dataset.aba === 'inicio' && caminho === '/') || (a.dataset.aba === 'empresas' && caminho.startsWith('/empresa'))));
  try {
    if (caminho === '/') {
      await telaInicio();
      timerAtualizacao = setInterval(() => { if (!document.hidden) telaInicio().catch(() => {}); }, 10_000);
    } else if (caminho === '/empresas') await telaEmpresas(params);
    else if (caminho.startsWith('/empresa/')) await telaEmpresa(caminho.split('/')[2]);
    else location.hash = '#/';
    window.scrollTo({ top: 0 });
  } catch (e) {
    if (e.message !== 'sessão expirada') $app.replaceChildren(h('div', { class: 'vazio' }, `Erro: ${e.message}`));
  }
}

async function iniciar() {
  const s = await api('GET', '/painel/sessao');
  if (!s.habilitado) {
    $app.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'cartao' },
      h('span', { class: 'marca-ionext' }, 'ionext'),
      h('p', { class: 'legenda' }, 'Painel desligado. Defina PAINEL_SENHA no arquivo .env e reinicie.'))));
    return;
  }
  if (!s.logado) return telaLogin();
  document.getElementById('topo').hidden = false;
  SEGMENTOS = await api('GET', '/v1/segmentos');
  render();
}

window.addEventListener('hashchange', render);
document.getElementById('sair').addEventListener('click', async () => { await api('POST', '/painel/sair'); telaLogin(); });
iniciar();
