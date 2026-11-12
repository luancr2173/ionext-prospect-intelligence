import { describe, expect, it } from 'vitest';
import {
  classificarPresenca, classificarUrl, confirmarTitularidade, dominiosCandidatos, pareceParking,
  segmentoPorCnae, similaridadeNomes, SEGMENTOS, TODOS_CNAES_ALVO,
} from '../src/index.ts';

describe('classificarUrl', () => {
  it('identifica redes, diretórios e candidatos a site', () => {
    expect(classificarUrl('https://www.instagram.com/sorrisofeliz/')).toEqual({ tipo: 'rede', rede: 'instagram' });
    expect(classificarUrl('https://wa.me/5561999999999')).toEqual({ tipo: 'rede', rede: 'whatsapp' });
    expect(classificarUrl('https://linktr.ee/sorriso')).toEqual({ tipo: 'rede', rede: 'linktree' });
    expect(classificarUrl('https://www.doctoralia.com.br/clinica/x')).toEqual({ tipo: 'diretorio' });
    expect(classificarUrl('https://cnpj.biz/11222333000181')).toEqual({ tipo: 'diretorio' });
    expect(classificarUrl('https://saude.df.gov.br/x')).toEqual({ tipo: 'diretorio' });
    expect(classificarUrl('https://sorrisofeliz.com.br/')).toEqual({ tipo: 'candidato_site' });
    expect(classificarUrl('não é url')).toEqual({ tipo: 'invalida' });
  });
});

describe('dominiosCandidatos', () => {
  it('gera poucos domínios prováveis, sem palavras genéricas do segmento', () => {
    const d = dominiosCandidatos(['Clínica Sorriso Feliz'], ['clinica', 'odonto']);
    expect(d).toEqual(['sorrisofeliz.com.br', 'sorrisofeliz.com', 'clinicasorrisofeliz.com.br', 'clinicasorrisofeliz.com', 'sorriso-feliz.com.br', 'sorriso-feliz.com']);
  });
  it('ignora nomes curtos demais', () => {
    expect(dominiosCandidatos(['AB'])).toEqual([]);
  });
});

describe('titularidade', () => {
  const dados = { cnpj: '11222333000181', telefones: ['+556133221100'], nomes: ['Clínica Sorriso Feliz'], cidade: 'Brasília', bairro: 'Asa Norte' };
  it('confirma por CNPJ, telefone ou nome + local', () => {
    expect(confirmarTitularidade('CNPJ 11.222.333/0001-81', dados).sinais).toEqual(['cnpj']);
    expect(confirmarTitularidade('Ligue (61) 3322-1100', dados).sinais).toEqual(['telefone']);
    expect(confirmarTitularidade('Clínica Sorriso Feliz — Asa Norte', dados).sinais).toEqual(['nome+local']);
  });
  it('não confirma só pelo nome', () => {
    expect(confirmarTitularidade('Clínica Sorriso Feliz em São Paulo', dados).confirmado).toBe(false);
  });
  it('detecta página de estacionamento/hospedagem', () => {
    expect(pareceParking('<html><body>This domain is for sale! Buy now.</body></html>')).toBe(true);
    expect(pareceParking('<html><body><h1>Welcome to nginx!</h1></body></html>')).toBe(true);
  });
});

describe('similaridade e segmentos', () => {
  it('compara nomes por termos', () => {
    expect(similaridadeNomes('Clínica Sorriso Feliz LTDA', 'Sorriso Feliz Clínica')).toBe(1);
    expect(similaridadeNomes('Sorriso Feliz', 'Odonto Brasil')).toBe(0);
  });
  it('todo CNAE-alvo tem 7 dígitos e aponta para um segmento', () => {
    for (const c of TODOS_CNAES_ALVO) {
      expect(c).toMatch(/^\d{7}$/);
      expect(segmentoPorCnae(c)).toBeDefined();
    }
    expect(SEGMENTOS.map((s) => s.id)).toContain('clinica_odontologica');
  });
});

describe('inconclusivo', () => {
  it('site sem titularidade confirmada nunca vira SEM_SITE', () => {
    const r = classificarPresenca({
      V1: { status: 'nao_executado' }, V2: { status: 'nada_encontrado' }, V3: { status: 'nao_aplicavel' },
      V4: { status: 'inconclusivo', url: 'https://x.com.br', detalhe: 'nome aparece' },
      V5: { status: 'nao_executado' }, V6: { status: 'executado', redes: [] },
    });
    expect(r.classificacao).toBe('PENDENTE');
  });
});

// Regressão: falsos positivos reais da primeira busca (clínicas odontológicas, DF, 12/11/2026)
import { avaliarSitePara, dominioCombinaComNome, ehProvedorEmail, paginaRasa, tokensDistintivos } from '../src/index.ts';

describe('avaliarSitePara — diretórios e homônimos', () => {
  const pagina = (t: string) => `<html><body><nav><a href="/">x</a></nav>${t}</body></html>`;
  const clinica = { cnpj: '33512963000123', telefones: ['+556133445566'], nomes: ['Centro de Reabilitacao Oral Dr Walter Vasques'],
                    cidade: 'Brasília', bairro: 'Asa Sul', genericas: ['odonto', 'odontologia', 'clinica', 'dental'] };

  it('consulta de CNPJ com CNPJ e telefone da empresa NÃO é site próprio', () => {
    const v = avaliarSitePara('https://empresas.serasaexperian.com.br/consulta-gratis/CENTRO-DE-REABILITACAO-33512963000123',
      pagina('CNPJ 33.512.963/0001-23 (61) 3344-5566 Walter Vasques Brasília'), clinica, 'busca');
    expect(v.tipo).toBe('terceiro');
  });
  it('guia desconhecido com página profunda e telefone NÃO é site próprio', () => {
    const v = avaliarSitePara('https://guia.qualquer-coisa.com/distrito-federal/brasilia/walter-vasques-3494756',
      pagina('Walter Vasques — (61) 3344-5566 — Asa Sul, Brasília'), clinica, 'busca');
    expect(v.tipo).toBe('terceiro');
  });
  it('site de outra clínica não vale para nome genérico', () => {
    const generica = { ...clinica, cnpj: null, telefones: [], nomes: ['Clinica Odontologica Integrada S/S Ltda'] };
    expect(tokensDistintivos(generica.nomes, generica.genericas)).toEqual([]);
    const v = avaliarSitePara('https://premierodontologia.com.br/', pagina('Premier — Clínica Odontológica Integrada em Brasília, Asa Sul'), generica, 'busca');
    expect(v.tipo).toBe('terceiro');
  });
  it('site próprio: domínio com o nome + nome e bairro na página', () => {
    const v = avaliarSitePara('https://walterodontologia.com.br/', pagina('Dr. Walter Vasques — Reabilitação Oral — Asa Sul'), clinica, 'busca');
    expect(v.tipo).toBe('proprio');
  });
  it('site próprio com domínio diferente do nome: home com o telefone completo', () => {
    const v = avaliarSitePara('https://reabilitaoral.com.br/', pagina('Agende: (61) 3344-5566'), clinica, 'busca');
    expect(v.tipo).toBe('proprio');
  });
  it('domínio parecido com conteúdo sem relação é descartado', () => {
    const v = avaliarSitePara('https://walter.com.br/', pagina('Loja de roupas infantis'), clinica, 'nome');
    expect(v.tipo).toBe('terceiro');
  });
  it('e-mail de provedor (brnet) não é site', () => {
    expect(ehProvedorEmail('brnet.com.br')).toBe(true);
    const v = avaliarSitePara('https://brnet.com.br/', pagina('Internet banda larga'), { ...clinica, nomes: ['Cisb'] }, 'email');
    expect(v.tipo).toBe('terceiro');
  });
  it('helpers', () => {
    expect(dominioCombinaComNome('www.estheticalodontologia.com.br', ['Esthetical Odontologia Ltda'])).toBe(true);
    expect(dominioCombinaComNome('premierodontologia.com.br', ['Via Odontologia'])).toBe(false);
    expect(paginaRasa('https://x.com.br/')).toBe(true);
    expect(paginaRasa('https://x.com.br/dentista-asa-norte')).toBe(true);
    expect(paginaRasa('https://x.com.br/clinicas/df/abc-3494756')).toBe(false);
  });
});

// Regressão: falsos "sem site" e perfis não reconhecidos no reprocessamento (12/11/2026)
import { perfilCombinaComNome, siglas } from '../src/index.ts';

describe('siglas, revisão e Instagram', () => {
  const g = ['odonto', 'odontologia', 'clinica', 'dental'];
  const pag = (t: string) => `<html><body><nav><a href="/">x</a></nav>${t}</body></html>`;

  it('sigla + palavra do ramo no domínio combina; sigla + outra coisa não', () => {
    expect(siglas(['Clinica Odontologica Jc'], g)).toEqual(['jc']);
    expect(dominioCombinaComNome('jcdental.com.br', ['Clinica Odontologica Jc'], g)).toBe(true);
    expect(dominioCombinaComNome('csodonto.com.br', ['Cs - Odontopediatria e Ortodontia'], g)).toBe(true);
    expect(dominioCombinaComNome('cobodontologiabrasilia.com.br', ['Cob - Centro Odontologico Brasiliense S/S Ltda'], g)).toBe(true);
    expect(dominioCombinaComNome('usbank.com', ['Us Odontologia'], g)).toBe(false);
  });

  it('site achado na busca com domínio do nome e sem prova vai para revisão, não some', () => {
    const d = { cnpj: null, telefones: [], nomes: ['Lira Odontologia Especializada'], cidade: 'Brasília', bairro: 'Asa Norte', genericas: g };
    expect(avaliarSitePara('https://liraodonto.com.br/', pag('Bem-vindo'), d, 'busca').tipo).toBe('fraco');
    // domínio gerado do nome (V4) sem nada na página continua descartado
    expect(avaliarSitePara('https://liraodonto.com.br/', pag('Bem-vindo'), d, 'nome').tipo).toBe('terceiro');
  });

  it('Instagram: reconhece pelo @ ou pelo título; ignora post solto e outra empresa', () => {
    expect(perfilCombinaComNome('https://www.instagram.com/studiosetti.odonto', 'Studio Setti - Clínica Odontologica (@studiosetti.odonto)', ['Studio Setti Odontologia Integrada'], g)).toBe(true);
    expect(perfilCombinaComNome('https://www.instagram.com/cob.odontologia?hl=en', 'COB | Dentista em Brasília (@cob.odontologia)', ['Cob - Centro Odontologico Brasiliense S/S Ltda'], g)).toBe(true);
    expect(perfilCombinaComNome('https://www.instagram.com/odontollifebsb?hl=en', 'Clínica Odontolife Ltda (@odontollifebsb)', ['Odontolife Clinica Odontologica Ltda'], g)).toBe(true);
    expect(perfilCombinaComNome('https://www.instagram.com/odontopredf', 'Odonto PRE (@odontopredf)', ['Odonto Pre Clinica de Prevencao e Reabilitacao Ltda'], g)).toBe(true);
    expect(perfilCombinaComNome('https://www.instagram.com/reel/DeASG5OTduq', 'Instagram', ['Clinica Radiologica Safe Carneiro'], g)).toBe(false);
    expect(perfilCombinaComNome('https://www.instagram.com/bioodontologiaintegrada', 'Bio Odontologia Integrada (@bioodontologiaintegrada)', ['Clinica Odontologica Integrada S/S Ltda'], g)).toBe(false);
    expect(perfilCombinaComNome('https://www.instagram.com/clinicaortoriso?hl=en', 'Excelência em Odontologia (@clinicaortoriso)', ['Orthomaster Odontologia Integrada'], g)).toBe(false);
  });
});

describe('nome fantasia OU razão social; termo inteiro no domínio', () => {
  const g = ['odonto', 'odontologia', 'clinica', 'dental'];
  it('perfil bate com o nome fantasia mesmo se a razão social for outra', () => {
    const nomes = ['Studio Setti Odontologia Integrada', 'Clinica Odontologica Miranda Ss Ltda'];
    expect(perfilCombinaComNome('https://www.instagram.com/studiosetti.odonto', 'Studio Setti - Clínica Odontologica (@studiosetti.odonto)', nomes, g)).toBe(true);
    expect(perfilCombinaComNome('https://www.instagram.com/bagnatoodontologia', 'Bagnato Bagnato (@bagnatoodontologia)', ['Bagnato Odontologia Especializada', 'Nelson Jose Bagnato Ltda'], g)).toBe(true);
    expect(perfilCombinaComNome('https://www.instagram.com/patblom.endo', 'EndoBlom: Endo com tecnologia (@patblom.endo)', ['Endoblom', 'Coe Clinica Odontologica Especializada Ltda'], g)).toBe(true);
    expect(perfilCombinaComNome('https://www.instagram.com/drthiagoassad?hl=en', 'Dr. Thiago Assad | Endodontia | Brasília (@drthiagoassad)', ['Centro Especializado de Endodontia', 'Centro Especializado de Endodontia Ltda'], g)).toBe(false);
    expect(perfilCombinaComNome('https://www.instagram.com/centrovidaodontologia?hl=en', 'Centrovida | Odontologia e Saúde Integrativa', ['Centro Odontologia', 'Centro Odontologia - Servicos Odontologicos Ltda'], g)).toBe(false);
  });
  it('termo do nome precisa estar inteiro no domínio', () => {
    expect(dominioCombinaComNome('orthoclinodontologia.com.br', ['Inodonto'], g)).toBe(false);
    expect(dominioCombinaComNome('odontologiamontenegro.com.br', ['Clinica Odontologica Montenegro Ltda'], g)).toBe(true);
    expect(dominioCombinaComNome('drafernandafachini.com.br', ['Fachini Odontologia'], g)).toBe(true);
    expect(dominioCombinaComNome('clinicaoralpremium.com', ['Oral Clin'], g)).toBe(false);
  });
});
