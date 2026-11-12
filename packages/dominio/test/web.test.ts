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
