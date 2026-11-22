/**
 * Contrato de prestação de serviços gerado a partir de um orçamento APROVADO.
 *
 * Fluxo: dadosDoContrato() junta orçamento + cadastro da empresa + dados da IONEXT e diz o que falta;
 * montarContrato() transforma os dados num texto estruturado (cláusulas numeradas); gerarDocx() e gerarPdf()
 * desenham o MESMO texto, para os dois arquivos dizerem exatamente a mesma coisa.
 *
 * Base legal usada no texto: Código Civil (Lei 10.406/2002, com a redação da Lei 14.905/2024 para correção e
 * juros), LGPD (Lei 13.709/2018), CDC (Lei 8.078/1990) quando houver relação de consumo e CPC art. 784, III
 * (título executivo com duas testemunhas). O documento precisa ser revisado por advogado antes da assinatura.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  AlignmentType, BorderStyle, LevelFormat, Document, Footer, Header, Packer, PageNumber, Paragraph, ShadingType, Table, TableCell,
  TableRow, TextRun, WidthType,
} from 'docx';
import type { Sql } from '../db.ts';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- tipos

export type Cobranca = 'unico' | 'mensal' | 'anual';
export interface ItemOrcamento {
  servico_id?: string | null; chave?: string | null; nome: string; descricao?: string | null;
  cobranca: Cobranca; unidade?: string | null; preco: number; qtd: number;
}
export interface Desconto { tipo?: 'pct' | 'valor'; valor?: number; mensal?: boolean }
export interface Parte {
  razao_social: string | null; nome_fantasia?: string | null; documento: string | null; tipo_documento: 'CNPJ' | 'CPF';
  endereco: string | null; cidade: string | null; uf: string | null; cep: string | null; email: string | null;
  telefone?: string | null; representante_nome: string | null; representante_cpf: string | null; representante_cargo: string | null;
}
export interface DadosContrato {
  numero: string;
  gerado_em: string;
  contratado: Parte;
  contratante: Parte;
  foro: { cidade: string | null; uf: string | null };
  orcamento: {
    numero: number; itens: (ItemOrcamento & { total: number })[];
    valor_unico: number; desconto_unico: number; valor_mensal: number; desconto_mensal: number; valor_anual: number;
    forma_pagamento: string | null; condicao_pagamento: string | null; vencimento_mensal: number | null;
    prazo_entrega_dias: number | null; validade: string | null; fidelidade_meses: number | null;
    observacoes: string | null; aprovado_em: string | null; criado_em: string;
  };
  porte_contratante: string | null;
}
export interface Faltando { campo: string; rotulo: string; grupo: 'ionext' | 'contratante' | 'orcamento' }

// ---------------------------------------------------------------- valores

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Mesma conta da tela de Precificação (o servidor refaz, não confia no total enviado). */
export function calcularValores(itens: ItemOrcamento[], d: Desconto) {
  const soma = (c: Cobranca) => itens.filter((i) => i.cobranca === c).reduce((t, i) => t + (Number(i.preco) || 0) * (Number(i.qtd) || 0), 0);
  const unico = soma('unico'); const mensal = soma('mensal'); const anual = soma('anual');
  const v = Math.max(0, Number(d.valor) || 0);
  const pct = d.tipo === 'pct' ? Math.min(v, 100) : 0;
  const descUnico = d.tipo === 'pct' ? unico * pct / 100 : Math.min(v, unico);
  const descMensal = d.tipo === 'pct' && d.mensal ? mensal * pct / 100 : 0;
  return { valor_unico: r2(unico), desconto_unico: r2(descUnico), valor_mensal: r2(mensal), desconto_mensal: r2(descMensal), valor_anual: r2(anual) };
}

const UNIDADES = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze',
  'catorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DEZENAS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CENTENAS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

function ate999(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const c = Math.floor(n / 100); const resto = n % 100;
  const partes: string[] = [];
  if (c) partes.push(CENTENAS[c]!);
  if (resto) partes.push(resto < 20 ? UNIDADES[resto]! : [DEZENAS[Math.floor(resto / 10)], UNIDADES[resto % 10]].filter(Boolean).join(' e '));
  return partes.join(' e ');
}

/** 1234 → "mil, duzentos e trinta e quatro" (sem moeda). */
export function numeroPorExtenso(numero: number): string {
  let inteiro = Math.floor(Math.abs(numero));
  if (inteiro === 0) return 'zero';
  const grupos: number[] = [];
  while (inteiro > 0) { grupos.push(inteiro % 1000); inteiro = Math.floor(inteiro / 1000); }
  const nomes = [['', ''], ['mil', 'mil'], ['milhão', 'milhões'], ['bilhão', 'bilhões']];
  const pedacos: { texto: string; n: number }[] = [];
  for (let i = grupos.length - 1; i >= 0; i--) {
    const g = grupos[i]!; if (!g) continue;
    const nome = i === 0 ? '' : g === 1 ? nomes[i]![0]! : nomes[i]![1]!;
    const num = i === 1 && g === 1 ? '' : ate999(g);
    pedacos.push({ texto: [num, nome].filter(Boolean).join(' '), n: g });
  }
  let t = '';
  pedacos.forEach((p, idx) => {
    if (idx === 0) { t = p.texto; return; }
    // "e" antes do último grupo quando ele é < 100 ou centena redonda; senão vírgula
    t += idx === pedacos.length - 1 && (p.n < 100 || p.n % 100 === 0) ? ` e ${p.texto}` : `, ${p.texto}`;
  });
  return t;
}

/** 2500 → "dois mil e quinhentos reais"; 1234.5 → "mil, duzentos e trinta e quatro reais e cinquenta centavos". */
export function porExtenso(valor: number): string {
  const totalCent = Math.round(valor * 100);
  const reaisN = Math.floor(totalCent / 100); const centavos = totalCent % 100;
  if (reaisN === 0 && centavos === 0) return 'zero real';
  const reais = reaisN === 0 ? '' : `${numeroPorExtenso(reaisN)}${reaisN >= 1_000_000 && reaisN % 1_000_000 === 0 ? ' de reais' : reaisN === 1 ? ' real' : ' reais'}`;
  const cent = centavos ? `${numeroPorExtenso(centavos)} ${centavos === 1 ? 'centavo' : 'centavos'}` : '';
  return [reais, cent].filter(Boolean).join(' e ');
}

export const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 });
const brlExtenso = (v: number) => `${brl(v)} (${porExtenso(v)})`;

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const dataPorExtenso = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00-03:00` : iso);
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(d);
  const v = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return `${v('day') === 1 ? '1º' : v('day')} de ${MESES[v('month') - 1]} de ${v('year')}`;
};
const dataCurta = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00-03:00` : iso)
  .toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

export function formatarDocumento(doc: string | null | undefined): string | null {
  const d = String(doc ?? '').replace(/\D/g, '');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return doc ? String(doc) : null;
}

const formatarCep = (cep: string) => { const d = cep.replace(/\D/g, ''); return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : cep; };

// ---------------------------------------------------------------- dados

const limpo = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const UF = /^[A-Za-z]{2}$/;

/** Junta orçamento, empresa e IONEXT. Não inventa nada: o que não existe vai para "faltando". */
export async function dadosDoContrato(sql: Sql, orcamentoId: string) {
  const [o] = await sql`
    select o.*, o.valor_unico::float as valor_unico, o.valor_mensal::float as valor_mensal, o.valor_anual::float as valor_anual,
           o.desconto_unico::float as desconto_unico, o.desconto_mensal::float as desconto_mensal, o.validade::text as validade,
           e.razao_social as e_razao, e.nome_fantasia as e_fantasia, e.cnpj as e_cnpj, e.endereco as e_endereco, e.bairro as e_bairro,
           e.cidade as e_cidade, e.uf as e_uf, e.cep as e_cep, e.porte as e_porte,
           (select c.valor from contato c where c.empresa_id = e.id and c.tipo = 'email' and c.publico_comercial
             order by c.valor limit 1) as e_email
      from orcamento o join empresa e on e.id = o.empresa_id where o.id = ${orcamentoId}`;
  if (!o) return null;
  const [i] = await sql`select * from ionext_dados where id = 1`;
  const ct = (o.contratante ?? {}) as Record<string, unknown>;

  const docContratante = limpo(ct.documento) ?? limpo(o.e_cnpj);
  const digitos = String(docContratante ?? '').replace(/\D/g, '');
  // bairro sozinho não é endereço: só usa o cadastro se houver logradouro
  const enderecoEmpresa = limpo(o.e_endereco) ? [limpo(o.e_endereco), limpo(o.e_bairro)].filter(Boolean).join(', ') : null;
  const contratante: Parte = {
    razao_social: limpo(ct.razao_social) ?? limpo(o.e_razao),
    nome_fantasia: limpo(o.e_fantasia),
    documento: formatarDocumento(docContratante),
    tipo_documento: digitos.length === 11 ? 'CPF' : 'CNPJ',
    endereco: limpo(ct.endereco) ?? enderecoEmpresa,
    cidade: limpo(ct.cidade) ?? limpo(o.e_cidade),
    uf: (limpo(ct.uf) ?? limpo(o.e_uf))?.toUpperCase() ?? null,
    cep: limpo(ct.cep) ?? limpo(o.e_cep),
    email: limpo(ct.email) ?? limpo(o.e_email),
    representante_nome: limpo(ct.representante_nome),
    representante_cpf: formatarDocumento(limpo(ct.representante_cpf)),
    representante_cargo: limpo(ct.representante_cargo),
  };
  const contratado: Parte = {
    razao_social: limpo(i?.razao_social), nome_fantasia: limpo(i?.nome_fantasia) ?? 'IONEXT',
    documento: formatarDocumento(limpo(i?.cnpj)), tipo_documento: String(i?.cnpj ?? '').replace(/\D/g, '').length === 11 ? 'CPF' : 'CNPJ',
    endereco: limpo(i?.endereco), cidade: limpo(i?.cidade), uf: limpo(i?.uf)?.toUpperCase() ?? null, cep: limpo(i?.cep),
    email: limpo(i?.email), telefone: limpo(i?.telefone),
    representante_nome: limpo(i?.representante_nome), representante_cpf: formatarDocumento(limpo(i?.representante_cpf)),
    representante_cargo: limpo(i?.representante_cargo),
  };
  const itens = (o.itens as ItemOrcamento[]).map((x) => ({ ...x, total: r2((Number(x.preco) || 0) * (Number(x.qtd) || 0)) }));
  const temUnico = itens.some((x) => x.cobranca === 'unico');

  const faltando: Faltando[] = [];
  const exige = (ok: unknown, campo: string, rotulo: string, grupo: Faltando['grupo']) => { if (!ok) faltando.push({ campo, rotulo, grupo }); };
  exige(contratado.razao_social, 'razao_social', 'Razão social da IONEXT', 'ionext');
  exige(contratado.documento && [11, 14].includes(String(contratado.documento).replace(/\D/g, '').length), 'cnpj', 'CNPJ da IONEXT', 'ionext');
  exige(contratado.endereco, 'endereco', 'Endereço da IONEXT', 'ionext');
  exige(contratado.cidade && contratado.uf && UF.test(contratado.uf), 'cidade', 'Cidade e UF da IONEXT', 'ionext');
  exige(contratado.representante_nome, 'representante_nome', 'Representante legal da IONEXT (quem assina)', 'ionext');
  exige(contratante.razao_social, 'razao_social', 'Razão social (ou nome completo) do cliente', 'contratante');
  exige([11, 14].includes(digitos.length), 'documento', 'CNPJ ou CPF do cliente', 'contratante');
  exige(contratante.endereco, 'endereco', 'Endereço do cliente', 'contratante');
  exige(contratante.cidade && contratante.uf && UF.test(contratante.uf), 'cidade', 'Cidade e UF do cliente', 'contratante');
  exige(contratante.representante_nome, 'representante_nome', 'Quem assina pelo cliente (representante legal)', 'contratante');
  exige(limpo(o.forma_pagamento), 'forma_pagamento', 'Forma de pagamento (ex.: PIX ou boleto)', 'orcamento');
  if (o.valor_unico > 0) exige(limpo(o.condicao_pagamento), 'condicao_pagamento', 'Condição de pagamento da implantação (ex.: 50% na assinatura e 50% na entrega)', 'orcamento');
  if (o.valor_mensal > 0) exige(o.vencimento_mensal, 'vencimento_mensal', 'Dia de vencimento da mensalidade', 'orcamento');
  if (temUnico) exige(o.prazo_entrega_dias, 'prazo_entrega_dias', 'Prazo de entrega (dias)', 'orcamento');

  const dados: DadosContrato = {
    numero: `CT-${new Date(o.criado_em).getFullYear()}-${String(o.numero).padStart(4, '0')}`,
    gerado_em: new Date().toISOString(),
    contratado, contratante,
    foro: { cidade: limpo(i?.foro_cidade) ?? contratado.cidade, uf: (limpo(i?.foro_uf) ?? contratado.uf)?.toUpperCase() ?? null },
    orcamento: {
      numero: o.numero, itens, valor_unico: o.valor_unico, desconto_unico: o.desconto_unico, valor_mensal: o.valor_mensal,
      desconto_mensal: o.desconto_mensal, valor_anual: o.valor_anual, forma_pagamento: limpo(o.forma_pagamento),
      condicao_pagamento: limpo(o.condicao_pagamento), vencimento_mensal: o.vencimento_mensal, prazo_entrega_dias: o.prazo_entrega_dias,
      validade: o.validade, fidelidade_meses: o.fidelidade_meses, observacoes: limpo(o.observacoes),
      aprovado_em: o.aprovado_em ? new Date(o.aprovado_em).toISOString() : null, criado_em: new Date(o.criado_em).toISOString(),
    },
    porte_contratante: limpo(o.e_porte),
  };
  return { status: o.status as string, dados, faltando };
}

// ---------------------------------------------------------------- texto

type Bloco =
  | { t: 'titulo'; texto: string }
  | { t: 'centro'; texto: string }
  | { t: 'clausula'; texto: string }
  | { t: 'par'; texto: string; num?: string }
  | { t: 'item'; texto: string }
  | { t: 'tabela'; cabecalho: string[]; linhas: string[][]; larguras: number[] }
  | { t: 'assinaturas' };

export interface ModeloContrato { titulo: string; numero: string; blocos: Bloco[]; dados: DadosContrato }

const ORD = (n: number) => `${n}ª`;
const COB = { unico: 'Pagamento único', mensal: 'Mensal', anual: 'Anual' } as const;

function qualificar(p: Parte, papel: string) {
  const doc = p.documento ? `inscrita no ${p.tipo_documento} sob o nº ${p.documento}` : '';
  const pessoaFisica = p.tipo_documento === 'CPF';
  const end = [p.endereco, p.cidade && p.uf ? `${p.cidade}/${p.uf}` : null, p.cep ? `CEP ${formatarCep(p.cep)}` : null].filter(Boolean).join(', ');
  const rep = !pessoaFisica && p.representante_nome
    ? `, neste ato representada por ${p.representante_nome}${p.representante_cargo ? `, ${p.representante_cargo}` : ''}${p.representante_cpf ? `, inscrito(a) no CPF sob o nº ${p.representante_cpf}` : ''}`
    : '';
  const email = p.email ? `, e-mail ${p.email}` : '';
  if (pessoaFisica) return `${p.razao_social}, pessoa física, inscrita no CPF sob o nº ${p.documento}, residente e domiciliada em ${end}${email}, doravante denominada ${papel}`;
  return `${p.razao_social}${p.nome_fantasia && p.nome_fantasia !== p.razao_social ? ` (nome fantasia ${p.nome_fantasia})` : ''}, pessoa jurídica de direito privado, ${doc}, com sede em ${end}${email}${rep}, doravante denominada ${papel}`;
}

export function montarContrato(d: DadosContrato): ModeloContrato {
  const o = d.orcamento;
  const b: Bloco[] = [];
  let n = 0;
  let sub = 0;
  const clausula = (titulo: string) => { n++; sub = 0; b.push({ t: 'clausula', texto: `CLÁUSULA ${ORD(n)} — ${titulo}` }); };
  const par = (texto: string) => { sub++; b.push({ t: 'par', num: `${n}.${sub}.`, texto }); };
  const item = (texto: string) => b.push({ t: 'item', texto });

  const unicos = o.itens.filter((i) => i.cobranca === 'unico');
  const recorrentes = o.itens.filter((i) => i.cobranca !== 'unico');
  const liquidoUnico = r2(o.valor_unico - o.desconto_unico);
  const liquidoMensal = r2(o.valor_mensal - o.desconto_mensal);
  const temAgente = o.itens.some((i) => /agente|agendamento|acompanhamento|whatsapp/i.test(`${i.chave ?? ''} ${i.nome}`));
  const temSite = o.itens.some((i) => /site|landing/i.test(`${i.chave ?? ''} ${i.nome}`));

  b.push({ t: 'titulo', texto: 'CONTRATO DE PRESTAÇÃO DE SERVIÇOS DE TECNOLOGIA' });
  b.push({ t: 'centro', texto: `Contrato nº ${d.numero} · referente ao orçamento nº ${o.numero}` });

  b.push({ t: 'par', texto: `Pelo presente instrumento particular, de um lado, ${qualificar(d.contratante, 'CONTRATANTE')}; e, de outro lado, ${qualificar(d.contratado, 'CONTRATADA')}; em conjunto denominadas PARTES, têm entre si justo e contratado o presente Contrato de Prestação de Serviços, que se regerá pelas cláusulas a seguir e pelos arts. 593 a 609 do Código Civil (Lei nº 10.406/2002).` });

  clausula('DAS PARTES');
  par('As PARTES estão qualificadas no preâmbulo deste contrato e declaram que os dados informados são verdadeiros, comprometendo-se a comunicar por escrito qualquer alteração de endereço, e-mail ou representante.');
  par('Quem assina por pessoa jurídica declara ter poderes para representá-la e obrigá-la neste ato.');

  clausula('DO OBJETO E DO ESCOPO DOS SERVIÇOS');
  par(`O objeto deste contrato é a prestação, pela CONTRATADA à CONTRATANTE, dos serviços descritos abaixo, conforme o orçamento nº ${o.numero}, aprovado pela CONTRATANTE${o.aprovado_em ? ` em ${dataCurta(o.aprovado_em)}` : ''}:`);
  b.push({
    t: 'tabela', cabecalho: ['Serviço', 'Escopo', 'Cobrança', 'Valor'], larguras: [26, 44, 13, 17],
    linhas: o.itens.map((i) => [
      `${i.nome}${Number(i.qtd) !== 1 ? ` (${i.qtd}x)` : ''}`,
      i.descricao || '—',
      COB[i.cobranca],
      `${brl(i.total)}${i.cobranca === 'mensal' ? '/mês' : i.cobranca === 'anual' ? '/ano' : ''}`,
    ]),
  });
  par('O escopo de cada serviço é o descrito na tabela acima. O que não estiver nela, inclusive novas páginas, novas funcionalidades, integrações com outros sistemas, produção de textos, fotos ou vídeos e campanhas de anúncios, não faz parte deste contrato e poderá ser contratado à parte, na forma da Cláusula de Alterações de Escopo.');
  par('Não estão incluídos no preço os custos de serviços de terceiros necessários à operação, como registro e renovação de domínio, contas em plataformas, número de telefone, licenças de software de terceiros e cobranças por uso de APIs (por exemplo, do WhatsApp ou de provedores de inteligência artificial), salvo se expressamente listados na tabela acima. Esses custos, quando existirem, serão informados previamente à CONTRATANTE.');
  if (o.observacoes) par(`Observações do orçamento: ${o.observacoes}`);

  clausula('DO PRAZO DE EXECUÇÃO E DO CRONOGRAMA');
  if (unicos.length && o.prazo_entrega_dias) {
    par(`A CONTRATADA entregará os serviços de implantação (pagamento único) em até ${o.prazo_entrega_dias} (${numeroPorExtenso(o.prazo_entrega_dias)}) dias corridos, contados da data em que, cumulativamente, (i) este contrato estiver assinado, (ii) a primeira parcela tiver sido paga e (iii) a CONTRATANTE tiver entregue os materiais, informações e acessos necessários.`);
    par('O trabalho seguirá o cronograma abaixo:');
    item('Etapa 1 — Alinhamento: reunião de início e envio, pela CONTRATANTE, dos materiais (textos, logotipo, fotos, informações do negócio e acessos), em até 5 (cinco) dias úteis da assinatura.');
    item('Etapa 2 — Desenvolvimento e configuração pela CONTRATADA.');
    item('Etapa 3 — Apresentação para validação e até 2 (duas) rodadas de ajustes dentro do escopo, que a CONTRATANTE deverá solicitar em até 5 (cinco) dias úteis de cada apresentação.');
    item('Etapa 4 — Entrega e publicação (ou ativação), com orientação de uso.');
    par('Considera-se aceita a entrega quando a CONTRATANTE a aprovar por escrito (inclusive por e-mail ou WhatsApp) ou quando não apontar, em até 5 (cinco) dias úteis do aviso de entrega, nenhuma falha em relação ao escopo contratado.');
    par('O prazo fica suspenso enquanto a CONTRATANTE não entregar os materiais, acessos ou aprovações que lhe cabem, e é prorrogado pelo mesmo tempo do atraso.');
  } else {
    par('Os serviços serão prestados a partir da assinatura deste contrato, conforme o escopo da Cláusula 2ª.');
  }
  if (recorrentes.length) {
    const fid = o.fidelidade_meses && o.fidelidade_meses > 0;
    par(`Os serviços de cobrança recorrente começam a contar a partir da entrega da implantação (ou da assinatura, se não houver implantação) e vigoram por prazo ${fid ? `mínimo de ${o.fidelidade_meses} (${numeroPorExtenso(o.fidelidade_meses!)}) meses, renovando-se depois automaticamente por prazo indeterminado` : 'indeterminado'}, podendo ser encerrados por qualquer das PARTES na forma da Cláusula de Rescisão.`);
  }

  clausula('DO VALOR, DA FORMA DE PAGAMENTO E DO ATRASO');
  if (o.valor_unico > 0) {
    par(`Pelos serviços de implantação, a CONTRATANTE pagará o valor total de ${brlExtenso(liquidoUnico)}${o.desconto_unico > 0 ? `, já com desconto de ${brl(o.desconto_unico)} sobre o valor de ${brl(o.valor_unico)}` : ''}, da seguinte forma: ${o.condicao_pagamento}.`);
  }
  if (o.valor_mensal > 0) {
    par(`Pelos serviços mensais, a CONTRATANTE pagará ${brlExtenso(liquidoMensal)} por mês${o.desconto_mensal > 0 ? `, já com desconto de ${brl(o.desconto_mensal)} sobre ${brl(o.valor_mensal)}` : ''}, com vencimento todo dia ${o.vencimento_mensal} de cada mês, sendo a primeira mensalidade devida no mês seguinte ao início do serviço.`);
  }
  if (o.valor_anual > 0) par(`Pelos serviços de cobrança anual, a CONTRATANTE pagará ${brlExtenso(o.valor_anual)} por ano, no início de cada período de 12 (doze) meses.`);
  par(`Os pagamentos serão feitos por ${o.forma_pagamento}, nos dados informados pela CONTRATADA. A CONTRATADA emitirá o documento fiscal correspondente.`);
  if (recorrentes.length) par('Os valores recorrentes serão reajustados a cada 12 (doze) meses pela variação positiva do IPCA/IBGE acumulada no período, ou por outro índice que o substitua.');
  par('O atraso no pagamento sujeitará a CONTRATANTE, sobre o valor em atraso, a multa de 2% (dois por cento), juros de mora de 1% (um por cento) ao mês, calculados dia a dia, e atualização monetária pela variação do IPCA/IBGE (art. 389, parágrafo único, do Código Civil).');
  if (recorrentes.length) par('Atraso superior a 15 (quinze) dias permite à CONTRATADA, após aviso por escrito com 5 (cinco) dias de antecedência, suspender os serviços recorrentes até a regularização, sem que isso configure descumprimento deste contrato.');

  clausula('DAS OBRIGAÇÕES DA CONTRATADA');
  par('São obrigações da CONTRATADA:');
  item('executar os serviços com qualidade técnica, dentro do escopo e dos prazos deste contrato;');
  item('manter a CONTRATANTE informada sobre o andamento e avisar com antecedência sobre qualquer fato que possa afetar o prazo;');
  item('corrigir, sem custo, falhas de funcionamento que decorram do seu trabalho e estejam dentro do escopo, apontadas em até 30 (trinta) dias da entrega;');
  if (temAgente) item('configurar o atendimento automatizado para que se identifique como assistente virtual e encaminhe para a equipe da CONTRATANTE os casos que exigirem uma pessoa;');
  item('guardar sigilo e proteger os dados a que tiver acesso, na forma das Cláusulas de Confidencialidade e de Proteção de Dados;');
  item('não usar a marca, os dados ou os contatos da CONTRATANTE para fim diferente deste contrato.');

  clausula('DAS OBRIGAÇÕES DA CONTRATANTE');
  par('São obrigações da CONTRATANTE:');
  item('pagar os valores nas datas combinadas;');
  item('entregar, nos prazos do cronograma, os materiais, informações, aprovações e acessos necessários, responsabilizando-se pela veracidade e pelos direitos de uso dos textos, imagens, marcas e demais conteúdos que fornecer;');
  item('indicar uma pessoa de contato com poderes para aprovar as entregas;');
  if (temAgente) item('manter atualizadas as informações usadas pelo atendimento automatizado (preços, horários, serviços e políticas) e revisar as respostas do agente quando avisada;');
  item('usar os serviços de acordo com a lei, inclusive as regras das plataformas de terceiros (como as políticas do WhatsApp) e a legislação de proteção de dados e de defesa do consumidor perante os seus próprios clientes.');

  clausula('DA PROPRIEDADE INTELECTUAL');
  if (temSite) par('Quitado integralmente o valor da implantação, a CONTRATANTE passa a ser titular dos direitos patrimoniais sobre o layout final e o conteúdo específicos do seu site, podendo usá-los livremente.');
  par('Permanecem da CONTRATADA, ou de seus licenciantes, os componentes, códigos, bibliotecas, modelos, rotinas, fluxos e conhecimentos técnicos preexistentes ou de uso geral empregados nos serviços, sobre os quais a CONTRATANTE recebe licença de uso não exclusiva, pelo tempo necessário ao uso das entregas. Componentes de código aberto seguem suas próprias licenças.');
  if (temAgente) par('As configurações, roteiros e fluxos do atendimento automatizado são licenciados à CONTRATANTE enquanto vigorarem os serviços recorrentes correspondentes. As informações, conversas e dados dos clientes da CONTRATANTE pertencem a ela, que poderá pedir a sua exportação ao fim do contrato.');
  par('A CONTRATADA poderá citar o trabalho em seu portfólio, sem divulgar informações confidenciais, salvo se a CONTRATANTE se opuser por escrito.');

  clausula('DA CONFIDENCIALIDADE');
  par('As PARTES manterão em sigilo as informações não públicas que uma receber da outra em razão deste contrato (dados comerciais, financeiros, técnicos, de clientes e acessos), usando-as apenas para cumprir este contrato.');
  par('Não são confidenciais as informações que já eram públicas, que se tornarem públicas sem culpa da parte que as recebeu ou cuja divulgação for exigida por lei ou ordem judicial, caso em que a outra parte será avisada, se possível.');
  par('O dever de sigilo vale durante o contrato e por 5 (cinco) anos após o seu término.');

  clausula('DA PROTEÇÃO DE DADOS PESSOAIS (LGPD)');
  par('As PARTES cumprirão a Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018 — LGPD). Quanto aos dados pessoais dos clientes e contatos da CONTRATANTE tratados por meio dos serviços (por exemplo, conversas no WhatsApp e formulários do site), a CONTRATANTE é a controladora e a CONTRATADA atua como operadora, tratando os dados apenas para executar este contrato e segundo as instruções da CONTRATANTE.');
  par('Cabe à CONTRATANTE definir a finalidade e a base legal do tratamento e informar os titulares, inclusive sobre o uso de atendimento automatizado.');
  par('A CONTRATADA adotará medidas de segurança técnicas e administrativas adequadas para proteger os dados contra acessos não autorizados e situações acidentais ou ilícitas, e comunicará à CONTRATANTE, em até 2 (dois) dias úteis de quando tomar conhecimento, qualquer incidente de segurança que possa afetá-los, para que a CONTRATANTE avalie a comunicação à ANPD e aos titulares.');
  par('A CONTRATADA poderá usar provedores de infraestrutura e de software necessários aos serviços (como hospedagem, envio de mensagens e inteligência artificial), que podem armazenar dados fora do Brasil, exigindo deles proteção compatível com a LGPD e observando os arts. 33 a 36 da LGPD.');
  par('A CONTRATADA ajudará a CONTRATANTE a atender pedidos dos titulares relativos aos dados tratados nos serviços e, ao fim do contrato, devolverá ou eliminará esses dados, salvo os que precise guardar por obrigação legal.');

  clausula('DAS ALTERAÇÕES DE ESCOPO');
  par('Qualquer inclusão, exclusão ou mudança no escopo deverá ser pedida por escrito. A CONTRATADA informará o impacto em preço e prazo, e a alteração só valerá depois de aprovada por escrito pela CONTRATANTE (inclusive por e-mail ou WhatsApp) ou formalizada em termo aditivo.');
  par('Ajustes dentro do escopo e das rodadas previstas no cronograma não são considerados alteração de escopo.');

  clausula('DA RESCISÃO E DAS PENALIDADES');
  par('Qualquer das PARTES pode encerrar este contrato sem justa causa, mediante aviso por escrito com 30 (trinta) dias de antecedência.');
  if (unicos.length) par('Se a CONTRATANTE desistir da implantação antes da entrega, pagará pelas etapas já executadas, proporcionalmente ao trabalho realizado, mais multa de 10% (dez por cento) sobre o saldo da implantação que ainda não tiver sido pago. Se a desistência for da CONTRATADA, ela devolverá os valores recebidos por etapas ainda não executadas, mais multa de 10% (dez por cento) sobre esses valores.');
  if (o.fidelidade_meses && o.fidelidade_meses > 0) par(`O encerramento dos serviços recorrentes pela CONTRATANTE antes do prazo mínimo de ${o.fidelidade_meses} meses, sem justa causa, sujeita-a à multa de 20% (vinte por cento) sobre as mensalidades que faltarem para completar esse prazo.`);
  par('O contrato pode ser rescindido de imediato, por notificação escrita, se a outra parte descumprir obrigação contratual e não corrigir a falha em até 10 (dez) dias do aviso, ou em caso de falência ou recuperação judicial da outra parte, sem prejuízo da cobrança de perdas e danos comprovados.');
  par('Nenhuma das PARTES responde por atrasos ou falhas causados por caso fortuito ou força maior (art. 393 do Código Civil), inclusive indisponibilidade de serviços de terceiros que não dependam dela, como plataformas de mensagens, hospedagem e provedores de internet.');
  par('Salvo em caso de dolo ou culpa grave, a responsabilidade da CONTRATADA por danos decorrentes deste contrato fica limitada ao valor total pago pela CONTRATANTE nos 12 (doze) meses anteriores ao fato.');
  par('O encerramento do contrato não afasta os pagamentos devidos pelos serviços já prestados nem as obrigações de confidencialidade e de proteção de dados.');

  clausula('DAS DISPOSIÇÕES GERAIS');
  par('Este contrato não cria vínculo empregatício, societário ou de representação entre as PARTES, cada uma respondendo pelos seus próprios encargos trabalhistas, fiscais e previdenciários.');
  par('As comunicações entre as PARTES poderão ser feitas por e-mail ou WhatsApp para os contatos informados neste contrato.');
  par('A tolerância de uma parte com o descumprimento da outra não altera o contrato nem representa renúncia de direitos.');
  par('Se alguma cláusula for considerada inválida, as demais continuam válidas.');
  par('As PARTES admitem a assinatura deste contrato por meio eletrônico, com validade jurídica (art. 10, § 2º, da Medida Provisória nº 2.200-2/2001), e reconhecem este instrumento, assinado por duas testemunhas, como título executivo extrajudicial (art. 784, III, do Código de Processo Civil).');

  clausula('DO FORO E DA LEGISLAÇÃO APLICÁVEL');
  par('Este contrato é regido pelas leis da República Federativa do Brasil, em especial o Código Civil e, quando houver relação de consumo, o Código de Defesa do Consumidor (Lei nº 8.078/1990).');
  par(`Fica eleito o foro da Comarca de ${d.foro.cidade}/${d.foro.uf} para resolver questões deste contrato, com renúncia a qualquer outro, ressalvado, se houver relação de consumo, o direito da CONTRATANTE de propor a ação no foro do seu domicílio.`);

  b.push({ t: 'par', texto: 'E, por estarem assim justas e contratadas, as PARTES assinam este contrato em 2 (duas) vias de igual teor, ou eletronicamente, na presença das duas testemunhas abaixo.' });
  b.push({ t: 'centro', texto: `${d.contratado.cidade}/${d.contratado.uf}, ${dataPorExtenso(d.gerado_em)}.` });
  b.push({ t: 'assinaturas' });

  return { titulo: 'Contrato de Prestação de Serviços', numero: d.numero, blocos: b, dados: d };
}

/** O que o contrato usou e o que merece atenção antes de assinar. */
export function resumoDoContrato(d: DadosContrato) {
  const o = d.orcamento;
  const pontos: string[] = [];
  if (!d.contratante.representante_cpf && d.contratante.tipo_documento === 'CNPJ') pontos.push('Falta o CPF de quem assina pelo cliente: o contrato saiu sem ele (recomendável preencher).');
  if (!d.contratado.representante_cpf) pontos.push('Falta o CPF do representante da IONEXT: o contrato saiu sem ele.');
  if (!d.contratante.cep) pontos.push('O endereço do cliente está sem CEP.');
  if (!d.contratante.email) pontos.push('O cliente está sem e-mail no contrato; as comunicações dependerão do WhatsApp.');
  if (o.validade && o.aprovado_em && o.aprovado_em.slice(0, 10) > o.validade) pontos.push(`O orçamento foi aprovado depois da validade (${dataCurta(o.validade)}). Confirme se os preços continuam valendo.`);
  if (d.contratante.tipo_documento === 'CPF' || /mei|micro/i.test(d.porte_contratante ?? '')) pontos.push('O cliente é pessoa física ou microempresa: pode haver relação de consumo (CDC). Nesse caso, o foro do domicílio do cliente prevalece e cláusulas de multa e limitação de responsabilidade são avaliadas com mais rigor.');
  pontos.push('Prazos e percentuais padrão usados (confira se valem para este cliente): 5 dias úteis para aceite e para pedidos de ajuste, 2 rodadas de ajustes, aviso prévio de 30 dias, multa de 10% na desistência da implantação, multa de 20% na quebra de fidelidade (se houver), limitação de responsabilidade ao valor de 12 meses, reajuste anual pelo IPCA.');
  pontos.push('Testemunhas: preencha nome e CPF de duas pessoas na hora da assinatura.');
  pontos.push('Este documento foi gerado automaticamente e deve ser revisado por um advogado antes da assinatura.');
  return {
    dados_usados: {
      contrato: d.numero, orcamento: o.numero,
      contratante: `${d.contratante.razao_social} · ${d.contratante.tipo_documento} ${d.contratante.documento} · ${[d.contratante.endereco, `${d.contratante.cidade}/${d.contratante.uf}`].filter(Boolean).join(', ')} · assina: ${d.contratante.representante_nome}`,
      contratada: `${d.contratado.razao_social} · ${d.contratado.tipo_documento} ${d.contratado.documento} · assina: ${d.contratado.representante_nome}`,
      servicos: o.itens.map((i) => `${i.nome} (${COB[i.cobranca].toLowerCase()}): ${brl(i.total)}`),
      implantacao: o.valor_unico ? `${brl(r2(o.valor_unico - o.desconto_unico))} · ${o.condicao_pagamento}` : null,
      mensalidade: o.valor_mensal ? `${brl(r2(o.valor_mensal - o.desconto_mensal))}/mês · vence dia ${o.vencimento_mensal}` : null,
      anual: o.valor_anual ? `${brl(o.valor_anual)}/ano` : null,
      forma_pagamento: o.forma_pagamento,
      prazo_entrega: o.prazo_entrega_dias ? `${o.prazo_entrega_dias} dias corridos` : null,
      fidelidade: o.fidelidade_meses ? `${o.fidelidade_meses} meses` : 'sem fidelidade',
      foro: `${d.foro.cidade}/${d.foro.uf}`,
    },
    pontos_de_atencao: pontos,
  };
}

// ---------------------------------------------------------------- .docx

const FONTE = 'Arial';
const COR = '1F2937';

export async function gerarDocx(m: ModeloContrato): Promise<Buffer> {
  const corpo = (texto: string, extra: Partial<ConstructorParameters<typeof Paragraph>[0] & object> = {}) =>
    new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 120, line: 300 }, children: [new TextRun({ text: texto, font: FONTE, size: 21, color: COR })], ...extra });
  const filhos: (Paragraph | Table)[] = [];
  const largura = 9026; // A4 com margens de 2,54 cm
  for (const bl of m.blocos) {
    if (bl.t === 'titulo') filhos.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: bl.texto, bold: true, font: FONTE, size: 28, color: COR })] }));
    else if (bl.t === 'centro') filhos.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 240 }, children: [new TextRun({ text: bl.texto, font: FONTE, size: 21, color: COR })] }));
    else if (bl.t === 'clausula') filhos.push(new Paragraph({ keepNext: true, spacing: { before: 280, after: 120 }, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB', space: 2 } }, children: [new TextRun({ text: bl.texto, bold: true, font: FONTE, size: 22, color: COR })] }));
    else if (bl.t === 'par') filhos.push(new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 120, line: 300 }, children: [
      ...(bl.num ? [new TextRun({ text: `${bl.num} `, bold: true, font: FONTE, size: 21, color: COR })] : []),
      new TextRun({ text: bl.texto, font: FONTE, size: 21, color: COR })] }));
    else if (bl.t === 'item') filhos.push(corpo(bl.texto, { numbering: { reference: 'marcador', level: 0 } }));
    else if (bl.t === 'tabela') {
      const cols = bl.larguras.map((p) => Math.round(largura * p / 100));
      cols[cols.length - 1] = largura - cols.slice(0, -1).reduce((a, x) => a + x, 0);
      const celula = (texto: string, i: number, cab: boolean) => new TableCell({
        width: { size: cols[i]!, type: WidthType.DXA },
        shading: cab ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' } : undefined,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
        children: [new Paragraph({ alignment: i === 3 ? AlignmentType.RIGHT : AlignmentType.LEFT, children: [new TextRun({ text: texto, bold: cab, font: FONTE, size: 19, color: COR })] })],
      });
      filhos.push(new Table({
        width: { size: largura, type: WidthType.DXA }, columnWidths: cols,
        rows: [new TableRow({ tableHeader: true, children: bl.cabecalho.map((t, i) => celula(t, i, true)) }),
          ...bl.linhas.map((l) => new TableRow({ cantSplit: true, children: l.map((t, i) => celula(t, i, false)) }))],
      }));
      filhos.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
    } else if (bl.t === 'assinaturas') {
      const assinatura = (rotulo: string, nome: string, extra: string) => [
        new Paragraph({ spacing: { before: 560 }, keepNext: true, keepLines: true, alignment: AlignmentType.CENTER, children: [new TextRun({ text: '_______________________________________________', font: FONTE, size: 21 })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, children: [new TextRun({ text: nome, bold: true, font: FONTE, size: 21, color: COR })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, children: [new TextRun({ text: `${rotulo}${extra ? ` · ${extra}` : ''}`, font: FONTE, size: 19, color: '4B5563' })] }),
      ];
      const ct = m.dados.contratante; const cd = m.dados.contratado;
      filhos.push(...assinatura('CONTRATANTE', ct.razao_social ?? '', ct.representante_nome && ct.tipo_documento === 'CNPJ' ? `por ${ct.representante_nome}` : ''));
      filhos.push(...assinatura('CONTRATADA', cd.razao_social ?? '', cd.representante_nome ? `por ${cd.representante_nome}` : ''));
      filhos.push(new Paragraph({ spacing: { before: 480, after: 0 }, keepNext: true, children: [new TextRun({ text: 'TESTEMUNHAS', bold: true, font: FONTE, size: 21, color: COR })] }));
      for (const k of [1, 2]) {
        filhos.push(new Paragraph({ spacing: { before: 480 }, keepNext: true, children: [new TextRun({ text: `${k}. _______________________________________________`, font: FONTE, size: 21 })] }));
        filhos.push(new Paragraph({ keepNext: k === 1, children: [new TextRun({ text: 'Nome:                                                    CPF:', font: FONTE, size: 19, color: '4B5563' })] }));
      }
    }
  }
  const doc = new Document({
    creator: 'IONEXT', title: `${m.titulo} ${m.numero}`, description: 'Gerado a partir de orçamento aprovado — revisar com advogado antes de assinar',
    styles: { default: { document: { run: { font: FONTE, size: 21 } } } },
    numbering: { config: [{ reference: 'marcador', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 567, hanging: 283 } } } }] }] },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: `Contrato nº ${m.numero}`, font: FONTE, size: 16, color: '6B7280' })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
        new TextRun({ text: 'Página ', font: FONTE, size: 16, color: '6B7280' }), new TextRun({ children: [PageNumber.CURRENT], font: FONTE, size: 16, color: '6B7280' }),
        new TextRun({ text: ' de ', font: FONTE, size: 16, color: '6B7280' }), new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONTE, size: 16, color: '6B7280' })] })] }) },
      children: filhos,
    }],
  });
  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------- PDF

let pdfPronto: { createPdf: (d: unknown) => { getBuffer: () => Promise<Buffer> } } | null = null;
function pdfmake() {
  if (pdfPronto) return pdfPronto;
  const p = require('pdfmake');
  const dir = join(dirname(require.resolve('pdfmake/package.json')), 'fonts', 'Roboto');
  p.setFonts({ Roboto: { normal: join(dir, 'Roboto-Regular.ttf'), bold: join(dir, 'Roboto-Medium.ttf'), italics: join(dir, 'Roboto-Italic.ttf'), bolditalics: join(dir, 'Roboto-MediumItalic.ttf') } });
  p.setLocalAccessPolicy((caminho: string) => caminho.startsWith(dir));
  p.setUrlAccessPolicy?.(() => false);
  pdfPronto = p;
  return p;
}

export async function gerarPdf(m: ModeloContrato): Promise<Buffer> {
  const content: unknown[] = [];
  for (const bl of m.blocos) {
    if (bl.t === 'titulo') content.push({ text: bl.texto, style: 'titulo' });
    else if (bl.t === 'centro') content.push({ text: bl.texto, alignment: 'center', margin: [0, 6, 0, 12] });
    else if (bl.t === 'clausula') content.push({ text: bl.texto, style: 'clausula' });
    else if (bl.t === 'par') content.push({ text: bl.num ? [{ text: `${bl.num} `, bold: true }, bl.texto] : bl.texto, style: 'par' });
    else if (bl.t === 'item') content.push({ ul: [bl.texto], style: 'par', margin: [14, 0, 0, 6] });
    else if (bl.t === 'tabela') content.push({
      table: { headerRows: 1, dontBreakRows: true, widths: bl.larguras.map((p) => `${p}%`),
        body: [bl.cabecalho.map((t) => ({ text: t, bold: true, fillColor: '#F3F4F6' })),
          ...bl.linhas.map((l) => l.map((t, i) => ({ text: t, alignment: i === 3 ? 'right' : 'left' })))] },
      layout: { hLineColor: '#D1D5DB', vLineColor: '#D1D5DB', paddingTop: () => 4, paddingBottom: () => 4 },
      fontSize: 9.5, margin: [0, 2, 0, 10],
    });
    else if (bl.t === 'assinaturas') {
      const ct = m.dados.contratante; const cd = m.dados.contratado;
      const assina = (rotulo: string, nome: string, extra: string) => ({ stack: [
        { text: '_______________________________________________', margin: [0, 34, 0, 2] },
        { text: nome, bold: true }, { text: `${rotulo}${extra ? ` · ${extra}` : ''}`, color: '#4B5563', fontSize: 9.5 }], alignment: 'center' });
      const testemunha = (k: number) => ({ stack: [
        { text: `${k}. _______________________________________`, margin: [0, 30, 0, 2] },
        { text: 'Nome:', color: '#4B5563', fontSize: 9.5 }, { text: 'CPF:', color: '#4B5563', fontSize: 9.5 }] });
      content.push({ unbreakable: true, stack: [
        assina('CONTRATANTE', ct.razao_social ?? '', ct.representante_nome && ct.tipo_documento === 'CNPJ' ? `por ${ct.representante_nome}` : ''),
        assina('CONTRATADA', cd.razao_social ?? '', cd.representante_nome ? `por ${cd.representante_nome}` : ''),
        { text: 'TESTEMUNHAS', bold: true, margin: [0, 26, 0, 0] },
        { columns: [testemunha(1), testemunha(2)], columnGap: 20 }] });
    }
  }
  const doc = pdfmake().createPdf({
    pageSize: 'A4', pageMargins: [64, 64, 64, 60],
    info: { title: `${m.titulo} ${m.numero}`, author: 'IONEXT', subject: 'Gerado a partir de orçamento aprovado — revisar com advogado antes de assinar' },
    header: { text: `Contrato nº ${m.numero}`, alignment: 'right', fontSize: 8, color: '#6B7280', margin: [64, 28, 64, 0] },
    footer: (pagina: number, total: number) => ({ text: `Página ${pagina} de ${total}`, alignment: 'center', fontSize: 8, color: '#6B7280', margin: [0, 20, 0, 0] }),
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.25, color: '#1F2937' },
    styles: {
      titulo: { fontSize: 14, bold: true, alignment: 'center', margin: [0, 0, 0, 2] },
      clausula: { fontSize: 11, bold: true, margin: [0, 14, 0, 6] },
      par: { alignment: 'justify', margin: [0, 0, 0, 6] },
    },
    content,
  });
  return doc.getBuffer();
}
