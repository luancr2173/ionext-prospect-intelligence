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
  requestAnimationFrame(() => el.classList.add('visivel'));
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => {
    el.classList.remove('visivel');
    aviso.t = setTimeout(() => { el.hidden = true; }, 300);
  }, 3500);
}

// ------------------------------------------------------------------ movimento
const semMovimento = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Números contam do zero até o valor (só na entrada da tela, não na atualização automática). */
function contarNumeros(raiz) {
  if (semMovimento()) return;
  raiz.querySelectorAll('.kpi-valor, .passo-valor').forEach((el) => {
    const alvo = Number(el.textContent.replace(/\D/g, ''));
    if (!alvo) return;
    const t0 = performance.now(), dur = Math.min(900, 400 + alvo * 4);
    const passo = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(alvo * (1 - Math.pow(1 - p, 3))).toLocaleString('pt-BR');
      if (p < 1) requestAnimationFrame(passo);
    };
    el.textContent = '0';
    requestAnimationFrame(passo);
  });
}

/** Pílula da aba ativa desliza até a aba nova. */
function moverIndicador(animar) {
  const nav = document.querySelector('.abas');
  const ativa = nav && nav.querySelector('a.ativa');
  let ind = nav && nav.querySelector('.abas-indicador');
  if (!nav) return;
  if (!ind) { ind = h('span', { class: 'abas-indicador', 'aria-hidden': 'true' }); nav.prepend(ind); }
  if (!ativa) { ind.style.opacity = '0'; return; }
  if (!animar) ind.classList.add('sem-transicao');
  Object.assign(ind.style, { opacity: '1', width: `${ativa.offsetWidth}px`, transform: `translateX(${ativa.offsetLeft - 3}px)` });
  if (!animar) requestAnimationFrame(() => ind.classList.remove('sem-transicao'));
}
window.addEventListener('resize', () => { moverIndicador(false); deslizarAbaCanal(false); });

/** Filtros de canal (Funil e Empresas): a pílula sai da opção anterior e desliza até a nova. */
let abaCanalAnterior = null;
function lembrarAbaCanal() {
  const a = $app.querySelector('.abas-canal .aba-canal.ativa');
  abaCanalAnterior = a ? { left: a.offsetLeft, top: a.offsetTop, width: a.offsetWidth, height: a.offsetHeight } : null;
}
function deslizarAbaCanal(animar) {
  const grupo = $app.querySelector('.abas-canal');
  const ativa = grupo && grupo.querySelector('.aba-canal.ativa');
  if (!grupo || !ativa) return;
  grupo.classList.add('com-indicador');
  let ind = grupo.querySelector('.canal-indicador');
  if (!ind) { ind = h('span', { class: 'canal-indicador', 'aria-hidden': 'true' }); grupo.prepend(ind); }
  const pos = (r) => ({ width: `${r.width}px`, height: `${r.height}px`, transform: `translate(${r.left}px, ${r.top}px)` });
  const destino = { left: ativa.offsetLeft, top: ativa.offsetTop, width: ativa.offsetWidth, height: ativa.offsetHeight };
  if (animar && abaCanalAnterior && !semMovimento()) {
    ind.classList.add('sem-transicao');
    Object.assign(ind.style, pos(abaCanalAnterior));
    void ind.offsetWidth;
    ind.classList.remove('sem-transicao');
  }
  Object.assign(ind.style, pos(destino));
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
  respondeu: 'Respondeu', reuniao: 'Reunião', proposta: 'Proposta', ganha: 'Ganha', perdida: 'Perdida', descartada: 'Descartada', obsoleta: 'Desatualizada',
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

const CANAIS = { whatsapp: 'Com WhatsApp', fixo: 'Só telefone fixo', email: 'Só e-mail', sem_contato: 'Sem contato' };
const telFmt = (t) => {
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(t || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (t || '');
};
const ICONE_WA = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '12'); svg.setAttribute('height', '12'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('fill', 'currentColor');
  p.setAttribute('d', 'M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.3 14.2c-.2.6-1.3 1.2-1.8 1.3-.5.1-1 .1-1.7-.1-.4-.1-.9-.3-1.6-.6-2.8-1.2-4.6-4-4.7-4.2-.1-.2-1.1-1.5-1.1-2.9s.7-2.1 1-2.4c.3-.3.6-.3.7-.3h.6c.2 0 .4 0 .6.4l.8 2c.1.2.1.3 0 .5l-.3.5-.4.5c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.4 2.4 1.5.3.1.5.1.6-.1l.9-1.1c.2-.3.4-.2.6-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.3Z');
  svg.append(p);
  return svg;
};
const chipCanal = (canal, telefone) => {
  if (canal === 'whatsapp') return h('span', { class: 'canal canal-wa', title: 'Celular comercial: o Neo pode abordar' }, ICONE_WA(), telFmt(telefone) || 'WhatsApp');
  if (canal === 'fixo') return h('span', { class: 'canal canal-fixo', title: 'Só telefone fixo: o Neo não aborda' }, 'Fixo ', telFmt(telefone));
  if (canal === 'email') return h('span', { class: 'canal canal-fixo' }, 'Só e-mail');
  return h('span', { class: 'canal canal-nada' }, 'Sem contato');
};

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
    h('img', { class: 'marca-icone', src: '/painel/icone.svg', alt: '' }),
    h('span', { class: 'marca-ionext' }, 'ionext'),
    h('div', { class: 'legenda' }, 'Prospect Intelligence'),
    form)));
  senha.focus();
}

async function telaInicio() {
  const [resumo, buscas, hoje] = await Promise.all([atualizarMotor(), api('GET', '/v1/buscas?limite=15'), api('GET', '/v1/painel/hoje')]);
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
      h('span', { class: 'indice mono' }, '(01) — Painel'),
      h('h1', {}, 'Visão ', h('em', {}, 'geral')),
      h('p', { class: 'legenda' }, 'Empresas encontradas, verificadas e prontas para virar conversa.'))),

    h('div', { class: 'grade grade-4' },
      kpi('Empresas analisadas', t.empresas),
      kpi('Oportunidades abertas', t.oportunidades, 'sem site, só redes ou site fraco', true),
      kpi('Alta prioridade', t.alta_prioridade, 'score 70 ou mais'),
      kpi('Aguardando sua revisão', t.aguardando_revisao, t.aprovadas ? `${t.aprovadas} já aprovadas para o Neo` : 'nenhuma aprovada ainda')),

    h('div', { class: 'grade grade-2', style: { marginTop: '16px' } }, cartaoHoje(hoje), cartaoConversao(resumo.funil)),

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

const MOTIVO = { responder: 'Responder', parada: 'Parada', aprovar: 'Aprovar' };
const DICA_MOTIVO = {
  responder: () => 'respondeu — continue a conversa no WhatsApp',
  aprovar: () => 'alta prioridade com WhatsApp, ainda não aprovada',
  parada: (x) => `${STATUS[x.status]} há ${x.dias_na_etapa} d sem avançar`,
};

/** "O que fazer hoje": a primeira coisa que o painel mostra (respostas, paradas, melhores para aprovar). */
function cartaoHoje(hoje) {
  const itens = (hoje && hoje.itens) || [];
  const n = (m) => itens.filter((x) => x.motivo === m).length;
  return h('div', { class: 'cartao' },
    h('h2', {}, 'Para ', h('em', {}, 'hoje')),
    itens.length === 0 ? h('div', { class: 'hoje-vazio' }, 'Tudo em dia: ninguém esperando resposta e nada parado no funil.') :
      [h('p', { class: 'legenda', style: { margin: '-6px 0 10px' } },
        [n('responder') && `${n('responder')} esperando resposta`, n('parada') && `${n('parada')} parada${n('parada') > 1 ? 's' : ''}`,
          n('aprovar') && `${n('aprovar')} para aprovar`].filter(Boolean).join(' · ')),
      h('div', { class: 'hoje' }, itens.slice(0, 8).map((x) => h('a', { class: 'hoje-item', href: `#/empresa/${x.empresa_id}` },
        h('span', { class: `razao razao-${x.motivo}` }, MOTIVO[x.motivo]),
        h('div', {}, h('div', { class: 'item-titulo' }, x.nome_fantasia),
          h('div', { class: 'item-sub' }, [DICA_MOTIVO[x.motivo](x), x.bairro].filter(Boolean).join(' · '))),
        chipCanal(x.canal, x.telefone)))),
      itens.length > 8 && h('a', { class: 'coluna-mais', href: '#/funil' }, `+ ${itens.length - 8} no funil`)]);
}

/** Conversão entre etapas (Pipedrive/HubSpot): onde as conversas param. */
function cartaoConversao(f) {
  f = f || {};
  const passos = [['Abordadas', f.abordadas], ['Respostas', f.responderam], ['Reuniões', f.reunioes], ['Propostas', f.propostas], ['Ganhas', f.ganhas]];
  const base = passos[0][1] || 0;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const fechadas = (f.ganhas || 0) + (f.perdidas || 0);
  return h('div', { class: 'cartao' },
    h('h2', {}, 'Con', h('em', {}, 'versão')),
    base === 0 ? h('p', { class: 'legenda' }, 'Aparece assim que o Neo fizer as primeiras abordagens.') : [
      h('div', { class: 'conversao' }, passos.map(([rotulo, valor], i) => h('div', { class: 'passo' },
        h('span', { class: 'passo-rotulo' }, rotulo),
        h('span', { class: 'trilho' }, h('span', { style: { width: `${Math.max(pct(valor, base), valor ? 2 : 0)}%` } })),
        h('span', { class: 'passo-valor' }, (valor || 0).toLocaleString('pt-BR')),
        h('span', { class: 'passo-taxa', title: i === 0 ? '' : `${pct(valor, passos[i - 1][1])}% da etapa anterior` },
          i === 0 ? '' : `${pct(valor, passos[i - 1][1])}%`)))),
      h('div', { class: 'rodape-conversao' },
        h('span', {}, 'Taxa de resposta ', h('b', {}, `${pct(f.responderam, f.abordadas)}%`)),
        h('span', {}, 'Taxa de ganho ', h('b', {}, fechadas ? `${pct(f.ganhas, fechadas)}%` : '—'), fechadas ? ` (${f.ganhas} de ${fechadas} fechadas)` : ''),
        h('span', { class: 'ajuda' }, 'Conta a etapa atual de cada oportunidade.'))]);
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
    status: params.get('status') || '', busca: params.get('busca') || '', canal: params.get('canal') || '',
    pagina: Number(params.get('pagina') || 1),
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

  // abas por canal de contato, com contagem (respeitam os outros filtros)
  const totalCanais = Object.values(r.canais || {}).reduce((a, b) => a + b, 0);
  const aba = (valor, rotulo, n, extra) => h('button', {
    type: 'button', class: `aba-canal${filtros.canal === valor ? ' ativa' : ''}${extra ? ` ${extra}` : ''}`, onclick: () => navegar({ canal: valor }),
  }, rotulo, h('b', {}, (n || 0).toLocaleString('pt-BR')));

  // seleção para ações em lote
  const selecionadas = new Set();
  const barra = h('div', { class: 'barra-lote', hidden: true });
  const atualizarBarra = () => {
    barra.hidden = selecionadas.size === 0;
    const semZap = r.itens.filter((e) => selecionadas.has(e.oportunidade_id) && e.canal !== 'whatsapp').length;
    barra.replaceChildren(
      h('span', {}, `${selecionadas.size} selecionada${selecionadas.size > 1 ? 's' : ''}`),
      semZap > 0 && h('span', { class: 'ajuda' }, `${semZap} sem WhatsApp: o Neo não vai abordar essas.`),
      h('div', { class: 'acoes' },
        h('button', { class: 'botao azul pequeno', onclick: () => emLote('aprovada_para_contato', 'aprovadas para o Neo') }, 'Aprovar para o Neo'),
        h('button', { class: 'botao pequeno', onclick: () => emLote('revisada', 'marcadas como revisadas') }, 'Marcar revisadas'),
        h('button', { class: 'botao pequeno', onclick: () => emLote('descartada', 'descartadas') }, 'Descartar'),
        h('button', { class: 'botao-texto', onclick: () => { selecionadas.clear(); document.querySelectorAll('.tabela input[type=checkbox]').forEach((c) => { c.checked = false; }); atualizarBarra(); } }, 'Limpar')));
  };
  const emLote = async (status, texto) => {
    try {
      const x = await api('POST', '/v1/oportunidades/status-em-lote', { ids: [...selecionadas], status });
      aviso(`${x.atualizadas} ${texto}.`);
      render();
    } catch (e) { aviso(e.message); }
  };
  const caixa = (e) => {
    if (!e.oportunidade_id) return h('span');
    const c = h('input', { type: 'checkbox', class: 'marcar', 'aria-label': `Selecionar ${e.nome_fantasia}`,
      onclick: (ev) => ev.stopPropagation(),
      onchange: () => { c.checked ? selecionadas.add(e.oportunidade_id) : selecionadas.delete(e.oportunidade_id); atualizarBarra(); } });
    return c;
  };
  const todas = h('input', { type: 'checkbox', class: 'marcar', 'aria-label': 'Selecionar todas desta página', onchange: () => {
    document.querySelectorAll('.tabela tbody input[type=checkbox]').forEach((c) => { if (c.checked !== todas.checked) { c.checked = todas.checked; c.dispatchEvent(new Event('change')); } });
  } });

  const paginas = Math.max(1, Math.ceil(r.total / 50));
  $app.replaceChildren(
    h('div', { class: 'cabecalho' }, h('div', {},
      h('span', { class: 'indice mono' }, '(03) — Base'),
      h('h1', {}, 'Empre', h('em', {}, 'sas')),
      h('p', { class: 'legenda' }, `${r.total.toLocaleString('pt-BR')} encontradas${filtros.busca ? ' nesta busca' : ''}, ordenadas por score.`)),
      filtros.busca && h('a', { class: 'botao pequeno', href: '#/empresas' }, 'Ver todas')),
    h('div', { class: 'abas-canal', role: 'tablist', 'aria-label': 'Canal de contato' },
      aba('', 'Todas', totalCanais),
      aba('whatsapp', 'Com WhatsApp', r.canais.whatsapp, 'wa'),
      aba('fixo', 'Só telefone fixo', r.canais.fixo),
      aba('email', 'Só e-mail', r.canais.email),
      aba('sem_contato', 'Sem contato', r.canais.sem_contato)),
    h('div', { class: 'filtros' },
      busca,
      sel('classificacao', CLASSES, 'Toda presença'),
      sel('prioridade', { alta: 'Alta', media: 'Média', baixa: 'Baixa' }, 'Toda prioridade'),
      sel('status', STATUS, 'Todo status')),
    filtros.canal !== 'fixo' ? '' : h('p', { class: 'ajuda', style: { margin: '-6px 0 14px' } },
      'Telefone fixo não tem WhatsApp: o Neo não aborda essas empresas. Dá para ligar ou procurar um celular no perfil do Google e registrar na “Verificação manual” da ficha.'),
    barra,
    h('div', { class: 'cartao', style: { padding: '14px 10px' } },
      r.itens.length === 0 ? h('div', { class: 'vazio' }, 'Nenhuma empresa com esses filtros.') :
        h('table', { class: 'tabela' },
          h('thead', {}, h('tr', {}, h('th', { class: 'col-marcar' }, todas), ['Empresa', 'Canal', 'Presença', 'Prioridade', 'Status'].map((c) => h('th', {}, c)), h('th', { class: 'num' }, 'Score'))),
          h('tbody', {}, r.itens.map((e) => h('tr', { onclick: () => { location.hash = `#/empresa/${e.id}`; } },
            h('td', { class: 'col-marcar' }, caixa(e)),
            h('td', {}, h('div', { class: 'item-titulo' }, e.nome_fantasia), h('div', { class: 'item-sub' }, [nomeSegmento(e.segmento), e.bairro].filter(Boolean).join(' · '))),
            h('td', {}, chipCanal(e.canal, e.telefone)),
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

// ------------------------------------------------------------------ funil (CRM)
const ETAPAS = [
  ['revisar', 'A revisar', 'revisada'],
  ['aprovada_para_contato', 'Na fila do Neo', 'aprovada_para_contato'],
  ['abordada', 'Abordadas', 'abordada'],
  ['respondeu', 'Responderam', 'respondeu'],
  ['reuniao', 'Reunião marcada', 'reuniao'],
  ['proposta', 'Proposta', 'proposta'],
  ['ganha', 'Ganhas', 'ganha'],
  ['perdida', 'Perdidas', 'perdida'],
];

const relativo = (iso) => {
  if (!iso) return '';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 60) return `há ${Math.max(1, min)} min`;
  if (min < 60 * 24) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / 1440)} d`;
};

async function telaFunil(params) {
  const canal = params.get('canal') || '';
  const r = await api('GET', `/v1/pipeline${canal ? `?canal=${canal}` : ''}`);
  atualizarMotor();

  const prazos = r.prazos || {};
  const parada = (op) => prazos[op.etapa] != null && op.dias_na_etapa >= prazos[op.etapa];
  const diasTexto = (d) => (d < 1 ? 'hoje' : `${d} d`);
  let dobradas = new Set(['perdida']);
  try { const salvo = JSON.parse(localStorage.getItem('ionext-funil-dobradas') || 'null'); if (Array.isArray(salvo)) dobradas = new Set(salvo); } catch { /* padrão */ }
  const alternarDobra = (chave) => {
    dobradas.has(chave) ? dobradas.delete(chave) : dobradas.add(chave);
    try { localStorage.setItem('ionext-funil-dobradas', JSON.stringify([...dobradas])); } catch { /* sem storage */ }
    render();
  };

  const mover = async (op, status) => {
    if (status === 'aprovada_para_contato' && op.canal !== 'whatsapp') aviso('Sem WhatsApp: aprovada, mas o Neo não vai abordar esta empresa.');
    try {
      await api('PATCH', `/v1/oportunidades/${op.id}`, { status });
      if (!(status === 'aprovada_para_contato' && op.canal !== 'whatsapp')) aviso(`Movida para “${STATUS[status]}”.`);
      render();
    } catch (e) { aviso(e.message); }
  };

  const cartaoOp = (op) => {
    const menu = h('select', { class: 'mover', 'aria-label': `Mover ${op.nome_fantasia}`, onclick: (ev) => ev.stopPropagation(),
      onchange: () => menu.value && mover(op, menu.value) },
      h('option', { value: '' }, 'Mover para…'),
      ETAPAS.filter(([k]) => k !== op.etapa).map(([, rotulo, status]) => h('option', { value: status }, rotulo)),
      h('option', { value: 'descartada' }, 'Descartar'));
    const envio = op.ultimo_envio;
    const linhaNeo = envio
      ? `Neo: ${envio.tipo === 'primeira' ? '1ª mensagem' : 'follow-up'} ${envio.status === 'enviado' ? 'enviada' : envio.status} ${relativo(envio.quando)}`
      : null;
    return h('article', {
      class: `card-op${op.canal === 'whatsapp' ? '' : ' sem-zap'}${parada(op) ? ' parada' : ''}`, draggable: 'true', tabindex: '0',
      'data-nome': `${op.nome_fantasia} ${op.bairro || ''}`.toLowerCase(), 'data-id': op.id,
      ondragstart: (ev) => {
        ev.dataTransfer.setData('text/plain', op.id); ev.dataTransfer.effectAllowed = 'move';
        const el = ev.currentTarget; requestAnimationFrame(() => el.classList.add('arrastando'));
      },
      ondragend: (ev) => ev.currentTarget.classList.remove('arrastando'),
      onclick: () => { location.hash = `#/empresa/${op.empresa_id}`; },
      onkeydown: (ev) => { if (ev.key === 'Enter') location.hash = `#/empresa/${op.empresa_id}`; },
    },
      h('div', { class: 'card-topo' }, h('span', { class: 'card-nome' }, op.nome_fantasia), h('span', { class: 'score' }, op.lead_score ?? '—')),
      h('div', { class: 'item-sub' }, [op.bairro, TIPO_OP[op.tipo]].filter(Boolean).join(' · ')),
      h('div', { class: 'card-linha' }, chipCanal(op.canal, op.telefone), etiquetaPrioridade(op.prioridade)),
      linhaNeo && h('div', { class: 'card-neo' }, linhaNeo),
      h('div', { class: 'dias', title: `Nesta etapa desde ${quando(op.etapa_desde)}` },
        parada(op) ? `Parada · ${op.dias_na_etapa} d` : `Na etapa · ${diasTexto(op.dias_na_etapa)}`),
      op.ultima_interacao && h('div', { class: 'card-neo' }, `Última interação ${relativo(op.ultima_interacao)}`),
      menu);
  };

  const porId = new Map();
  Object.values(r.etapas).forEach((e) => e.itens.forEach((op) => porId.set(op.id, op)));

  const coluna = ([chave, rotulo, status]) => {
    const etapa = r.etapas[chave] || { total: 0, itens: [] };
    const col = h('section', { class: `coluna etapa-${chave}${dobradas.has(chave) ? ' dobrada' : ''}`, 'aria-label': rotulo,
      onclick: dobradas.has(chave) ? () => alternarDobra(chave) : null,
      ondragover: (ev) => { ev.preventDefault(); col.classList.add('alvo'); },
      ondragleave: () => col.classList.remove('alvo'),
      ondrop: (ev) => {
        ev.preventDefault(); col.classList.remove('alvo');
        const op = porId.get(ev.dataTransfer.getData('text/plain'));
        if (!op || op.etapa === chave) return;
        // move o cartão na hora (a API confirma em seguida e a tela se atualiza sem piscar)
        const cartao = kanban.querySelector(`[data-id="${op.id}"]`);
        if (cartao) {
          col.querySelector('.coluna-vazia')?.remove();
          col.querySelector('header').after(cartao);
          cartao.classList.remove('arrastando');
          cartao.classList.add('chegou');
        }
        mover(op, status);
      } },
      h('header', {}, h('span', {}, rotulo),
        h('span', { class: 'coluna-acoes' },
          etapa.itens.filter(parada).length > 0 && !dobradas.has(chave) && h('span', { class: 'paradas', title: `Paradas há ${prazos[chave]} dias ou mais` }, `${etapa.itens.filter(parada).length} parada${etapa.itens.filter(parada).length > 1 ? 's' : ''}`),
          h('b', {}, etapa.total),
          (chave === 'perdida' || chave === 'ganha') && h('button', { class: 'dobrar', type: 'button', title: dobradas.has(chave) ? 'Mostrar coluna' : 'Recolher coluna',
            'aria-label': dobradas.has(chave) ? `Mostrar ${rotulo}` : `Recolher ${rotulo}`, onclick: (ev) => { ev.stopPropagation(); alternarDobra(chave); } }, dobradas.has(chave) ? '›' : '‹'))),
      dobradas.has(chave) ? null : etapa.itens.length === 0 ? h('div', { class: 'coluna-vazia' }, 'Nada aqui') : etapa.itens.map(cartaoOp),
      !dobradas.has(chave) && etapa.total > etapa.itens.length && h('a', { class: 'coluna-mais', href: `#/empresas?status=${status === 'revisada' ? 'nova' : status}` }, `+ ${etapa.total - etapa.itens.length} na lista`));
    return col;
  };

  // colunas recolhidas vão para o fim, estreitas
  const abertas = ETAPAS.filter(([k]) => !dobradas.has(k));
  const fechadas = ETAPAS.filter(([k]) => dobradas.has(k));
  const kanban = h('div', { class: `kanban${fechadas.length ? ' com-dobrada' : ''}`,
    style: fechadas.length ? { gridTemplateColumns: `repeat(${abertas.length}, minmax(232px, 1fr))${' 52px'.repeat(fechadas.length)}` } : null },
    [...abertas, ...fechadas].map(coluna));
  const buscaFunil = h('input', { type: 'search', class: 'busca-funil', placeholder: 'Filtrar cartões…', 'aria-label': 'Filtrar cartões do funil',
    oninput: () => {
      const t = buscaFunil.value.trim().toLowerCase();
      kanban.querySelectorAll('.card-op').forEach((c) => { c.hidden = !!t && !c.dataset.nome.includes(t); });
    } });

  const filtro = (valor, rotulo) => h('a', { class: `aba-canal${canal === valor ? ' ativa' : ''}`, href: `#/funil${valor ? `?canal=${valor}` : ''}` }, rotulo);
  $app.replaceChildren(
    h('div', { class: 'cabecalho' }, h('div', {},
      h('span', { class: 'indice mono' }, '(02) — CRM'),
      h('h1', {}, 'Fu', h('em', {}, 'nil')),
      h('p', { class: 'legenda' }, 'Arraste os cartões entre as etapas ou use “Mover para…”. O Neo só aborda quem está em “Na fila do Neo” e tem WhatsApp.'))),
    h('div', { class: 'linha-filtros' },
      h('div', { class: 'abas-canal' }, filtro('', 'Todos os canais'), filtro('whatsapp', 'Com WhatsApp'), filtro('fixo', 'Só telefone fixo')),
      buscaFunil),
    kanban);
  $app.classList.add('largo');
}

async function telaEmpresa(id) {
  const f = await api('GET', `/v1/empresas/${id}`);
  const e = f.empresa;
  const p = f.presenca_digital;
  const ops = f.oportunidades.filter((o) => o.status !== 'descartada' && o.status !== 'obsoleta').sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0));
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
        chipCanal(f.neo && f.neo.whatsapp ? 'whatsapp' : (f.contatos.some((c) => c.tipo === 'telefone' || c.tipo === 'whatsapp') ? 'fixo' : (f.contatos.some((c) => c.tipo === 'email') ? 'email' : 'sem_contato')),
          f.neo && f.neo.whatsapp ? f.neo.whatsapp.numero : (f.contatos.find((c) => c.tipo === 'telefone') || {}).valor),
        op && h('span', { class: 'etiqueta e-alta' }, STATUS[op.status] || op.status),
        op && op.dias_na_etapa != null && h('span', { class: 'dias' }, op.dias_na_etapa < 1 ? 'nesta etapa desde hoje' : `nesta etapa há ${op.dias_na_etapa} d`),
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
        linhaDoTempo(f, op),
        cartaoNeo(f.neo),
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

/** Histórico da oportunidade num lugar só: mensagens do Neo, respostas e anotações. */
function linhaDoTempo(f, op) {
  const eventos = [];
  (f.neo ? f.neo.envios : []).filter((x) => !x.teste && x.status === 'enviado').forEach((x) => eventos.push({
    quando: x.enviado_em, tipo: 'saida', titulo: x.tipo === 'primeira' ? 'Neo enviou a primeira mensagem' : 'Neo enviou o follow-up', texto: x.mensagem }));
  (op ? op.interacoes || [] : []).forEach((i) => {
    if (i.registrado_por === 'neo' && i.direcao === 'saida' && /^(Primeira mensagem|Follow-up):/.test(i.resumo)) return; // já aparece pelo envio
    eventos.push({ quando: i.registrado_em, tipo: i.direcao, titulo: i.direcao === 'entrada' ? 'Resposta da empresa' : `Anotação · ${i.registrado_por}`, texto: i.resumo });
  });
  (op ? op.etapas || [] : []).forEach((x) => eventos.push({
    quando: x.em, tipo: 'etapa', titulo: `${STATUS[x.de] || x.de} → ${STATUS[x.para] || x.para}${x.por ? ` · ${x.por}` : ''}` }));
  eventos.sort((a, b) => new Date(b.quando) - new Date(a.quando));
  const registrar = h('textarea', { rows: '2', placeholder: 'Anotar: ligação, combinado, próximo passo…' });
  const salvar = h('button', { class: 'botao pequeno', onclick: async () => {
    const texto = registrar.value.trim();
    if (!texto || !op) return;
    try { await api('PATCH', `/v1/oportunidades/${op.id}`, { status: op.status, observacao: texto }); aviso('Anotação registrada.'); render(); }
    catch (e) { aviso(e.message); }
  } }, 'Registrar');
  return h('div', { class: 'cartao' },
    h('h2', {}, 'Linha do tempo'),
    eventos.length === 0 ? h('p', { class: 'legenda' }, 'Nenhuma conversa ainda.') :
      h('ol', { class: 'tempo' }, eventos.map((ev) => h('li', { class: `tempo-${ev.tipo}` },
        h('div', { class: 'tempo-titulo' }, ev.titulo, h('span', { class: 'item-sub' }, quando(ev.quando))),
        ev.texto && h('div', { class: 'tempo-texto' }, ev.texto)))),
    op && h('div', { class: 'anotar' }, registrar, salvar));
}

function cartaoNeo(neo) {
  if (!neo) return null;
  const rotulo = { reservado: 'na fila', enviado: 'enviado', falhou: 'falhou', cancelado: 'cancelado' };
  const classe = { reservado: 'e-media', enviado: 'e-ok', falhou: 'e-baixa', cancelado: 'e-baixa' };
  return h('div', { class: 'cartao' },
    h('h2', {}, 'Neo (WhatsApp)'),
    neo.whatsapp
      ? h('p', {}, `Número para abordagem: ${neo.whatsapp.numero}`, h('br'), h('small', { class: 'legenda' }, `celular comercial · fonte: ${neo.whatsapp.fonte}`))
      : h('p', { class: 'ajuda' }, 'Sem celular comercial confirmado. O Neo não aborda telefone fixo; mesmo aprovada, esta empresa não entra na fila.'),
    neo.envios.length === 0 ? h('p', { class: 'legenda' }, 'Nenhuma mensagem até agora.') :
      neo.envios.map((x) => h('div', { class: 'evid' },
        h('span', { class: `etiqueta ${classe[x.status] || ''}` }, rotulo[x.status] || x.status),
        h('div', {},
          h('div', {}, `${x.tipo === 'primeira' ? 'Primeira mensagem' : 'Follow-up'}${x.teste ? ' · teste (foi para o seu número)' : ''}`),
          x.mensagem && h('div', { class: 'item-sub', style: { whiteSpace: 'pre-wrap' } }, x.mensagem),
          x.erro && h('div', { class: 'item-sub' }, `Motivo: ${x.erro}`),
          h('div', { class: 'item-sub' }, quando(x.enviado_em || x.reservado_em))))));
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
      // antes do contato: revisar e aprovar para o Neo
      ['nova', 'revisada'].includes(op.status) && h('button', { class: 'botao azul', onclick: () => mudar('aprovada_para_contato', 'Aprovada para o Neo.') }, 'Aprovar para o Neo'),
      op.status === 'nova' && h('button', { class: 'botao', onclick: () => mudar('revisada', 'Marcada como revisada.') }, 'Marcar revisada'),
      op.status === 'aprovada_para_contato' && h('button', { class: 'botao', onclick: () => mudar('revisada', 'Tirada da fila do Neo.') }, 'Tirar da fila do Neo'),
      // depois do contato: etapas do funil
      ['abordada', 'respondeu'].includes(op.status) && h('button', { class: 'botao azul', onclick: () => mudar('reuniao', 'Reunião marcada.') }, 'Reunião marcada'),
      ['abordada', 'respondeu', 'reuniao'].includes(op.status) && h('button', { class: op.status === 'reuniao' ? 'botao azul' : 'botao', onclick: () => mudar('proposta', 'Proposta enviada.') }, 'Proposta enviada'),
      ['reuniao', 'proposta'].includes(op.status) && h('button', { class: 'botao', onclick: () => mudar('ganha', 'Negócio ganho!') }, 'Ganha'),
      ['abordada', 'respondeu', 'reuniao', 'proposta'].includes(op.status) && h('button', { class: 'botao', onclick: () => mudar('perdida', 'Marcada como perdida.') }, 'Perdida'),
      ['nova', 'revisada', 'aprovada_para_contato'].includes(op.status) && h('button', { class: 'botao', onclick: () => mudar('descartada', 'Descartada.') }, 'Descartar'),
      ['descartada', 'perdida', 'obsoleta'].includes(op.status) && h('button', { class: 'botao', onclick: () => mudar('nova', 'Reaberta.') }, 'Reabrir'),
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

let ultimaTela = null;
async function render() {
  clearInterval(timerAtualizacao);
  const [caminho, qs] = (location.hash.slice(1) || '/').split('?');
  const novoEndereco = location.hash !== render.hash;
  render.hash = location.hash;
  const entrando = caminho !== ultimaTela;
  const primeira = ultimaTela === null;
  ultimaTela = caminho;
  const filtrando = !entrando && novoEndereco;
  if (!semMovimento()) {
    if (entrando) $app.classList.add('saindo');
    else if (filtrando) $app.classList.add('trocando');
    lembrarAbaCanal();
  }
  const params = new URLSearchParams(qs || '');
  document.querySelectorAll('.abas a').forEach((a) => a.classList.toggle('ativa',
    (a.dataset.aba === 'inicio' && caminho === '/') || (a.dataset.aba === 'empresas' && caminho.startsWith('/empresa'))
    || (a.dataset.aba === 'funil' && caminho === '/funil')));
  moverIndicador(!primeira);
  $app.classList.remove('largo');
  try {
    if (caminho === '/') {
      await telaInicio();
      timerAtualizacao = setInterval(() => { if (!document.hidden) telaInicio().catch(() => {}); }, 10_000);
    } else if (caminho === '/empresas') await telaEmpresas(params);
    else if (caminho === '/funil') await telaFunil(params);
    else if (caminho.startsWith('/empresa/')) await telaEmpresa(caminho.split('/')[2]);
    else location.hash = '#/';
    if (novoEndereco) window.scrollTo({ top: 0 });
    if (entrando) {
      if (!semMovimento()) {
        $app.classList.remove('entrando');
        void $app.offsetWidth; // reinicia a animação
        $app.classList.add('entrando');
        contarNumeros($app);
        clearTimeout(render.t);
        render.t = setTimeout(() => $app.classList.remove('entrando'), 1200);
      }
    } else if (filtrando && !semMovimento()) {
      $app.classList.remove('filtrando');
      void $app.offsetWidth;
      $app.classList.add('filtrando');
      clearTimeout(render.t);
      render.t = setTimeout(() => $app.classList.remove('filtrando'), 900);
    }
    deslizarAbaCanal(filtrando);
  } catch (e) {
    if (e.message !== 'sessão expirada') $app.replaceChildren(h('div', { class: 'vazio' }, `Erro: ${e.message}`));
  } finally {
    $app.classList.remove('saindo', 'trocando');
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

// tema claro/escuro (tema.js já aplicou o salvo antes de pintar)
const corTema = () => document.querySelector('meta[name=theme-color]')
  .setAttribute('content', document.documentElement.dataset.theme === 'light' ? '#f4f2ee' : '#0a0a0c');
corTema();
document.getElementById('tema').addEventListener('click', (ev) => {
  const raiz = document.documentElement;
  const novo = raiz.dataset.theme === 'light' ? 'dark' : 'light';
  const aplicar = () => {
    raiz.dataset.theme = novo;
    try { localStorage.setItem('ionext-tema', novo); } catch { /* sem storage */ }
    corTema();
  };
  if (semMovimento()) return aplicar();
  if (!document.startViewTransition) {
    raiz.classList.add('trocando-tema'); aplicar();
    return setTimeout(() => raiz.classList.remove('trocando-tema'), 400);
  }
  const r = ev.currentTarget.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  raiz.style.setProperty('--tema-x', `${x}px`);
  raiz.style.setProperty('--tema-y', `${y}px`);
  raiz.style.setProperty('--tema-r', `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`);
  raiz.classList.add('revelando-tema');
  document.startViewTransition(aplicar).finished.finally(() => raiz.classList.remove('revelando-tema'));
});

// busca rápida no topo; atalho "/"
const campoBusca = document.getElementById('busca-rapida-campo');
document.getElementById('busca-rapida').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const t = campoBusca.value.trim();
  location.hash = t ? `#/empresas?q=${encodeURIComponent(t)}` : '#/empresas';
  campoBusca.blur();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key !== '/' || ev.ctrlKey || ev.metaKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  if (getComputedStyle(campoBusca.parentElement).display === 'none') return;
  ev.preventDefault(); campoBusca.focus();
});

window.addEventListener('hashchange', render);
document.getElementById('sair').addEventListener('click', async () => { await api('POST', '/painel/sair'); telaLogin(); });
iniciar();
