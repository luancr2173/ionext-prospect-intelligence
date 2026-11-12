import { describe, expect, it } from 'vitest';
import {
  calcularLeadScore, classificarPresenca, cnpjValido, dominioProprioDoEmail,
  normalizarNome, normalizarTelefone, tipoOportunidade, type Verificacoes,
} from '../src/index.ts';

describe('cnpj', () => {
  it('aceita CNPJ numérico válido com e sem máscara', () => {
    expect(cnpjValido('11.222.333/0001-81')).toBe(true);
    expect(cnpjValido('11222333000181')).toBe(true);
  });
  it('aceita o exemplo alfanumérico publicado pela Receita', () => {
    expect(cnpjValido('12.ABC.345/01DE-35')).toBe(true);
  });
  it('rejeita DV errado, repetidos e tamanho errado', () => {
    expect(cnpjValido('11222333000182')).toBe(false);
    expect(cnpjValido('11111111111111')).toBe(false);
    expect(cnpjValido('1122233300018')).toBe(false);
  });
});

describe('normalização', () => {
  it('nome sem acento, pontuação e sufixo jurídico', () => {
    expect(normalizarNome('Clínica Sorriso Feliz LTDA - ME')).toBe('clinica sorriso feliz');
    expect(normalizarNome('Barbearia do Zé S/A')).toBe('barbearia ze');
  });
  it('telefone em E.164 e rejeita sem DDD', () => {
    expect(normalizarTelefone('(61) 99814-5516')).toBe('+5561998145516');
    expect(normalizarTelefone('+55 61 3322-1100')).toBe('+556133221100');
    expect(normalizarTelefone('061 3322-1100')).toBe('+556133221100');
    expect(normalizarTelefone('99814-5516')).toBeNull();
  });
  it('domínio próprio do e-mail ignora provedores gratuitos', () => {
    expect(dominioProprioDoEmail('contato@clinicax.com.br')).toBe('clinicax.com.br');
    expect(dominioProprioDoEmail('clinicax@gmail.com')).toBeNull();
  });
});

const base: Verificacoes = {
  V1: { status: 'nao_executado' },
  V2: { status: 'nada_encontrado' },
  V3: { status: 'nao_aplicavel' },
  V4: { status: 'nada_encontrado' },
  V5: { status: 'nao_executado' },
  V6: { status: 'executado', redes: [] },
};

describe('classificação de presença', () => {
  it('SEM_SITE só quando todas as obrigatórias rodaram', () => {
    const r = classificarPresenca(base);
    expect(r.classificacao).toBe('SEM_SITE');
    expect(r.confiabilidade).toBe('media');
  });
  it('confiabilidade alta quando V1 e V5 também rodaram', () => {
    const r = classificarPresenca({ ...base, V1: { status: 'nada_encontrado' }, V5: { status: 'nada_encontrado' } });
    expect(r.confiabilidade).toBe('alta');
  });
  it('PENDENTE se uma obrigatória falhou — nunca SEM_SITE por omissão', () => {
    expect(classificarPresenca({ ...base, V4: { status: 'erro', detalhe: 'timeout' } }).classificacao).toBe('PENDENTE');
    expect(classificarPresenca({ ...base, V2: { status: 'nao_executado' } }).classificacao).toBe('PENDENTE');
    expect(classificarPresenca({ ...base, V6: { status: 'nao_executado' } }).classificacao).toBe('PENDENTE');
  });
  it('SOMENTE_REDES quando há só Instagram/WhatsApp', () => {
    const r = classificarPresenca({ ...base, V6: { status: 'executado', redes: ['instagram'] } });
    expect(r.classificacao).toBe('SOMENTE_REDES');
  });
  it('site acessível vence mesmo com outra verificação falhando', () => {
    const r = classificarPresenca({ ...base, V2: { status: 'erro', detalhe: 'x' }, V4: { status: 'site_encontrado', url: 'https://a.com.br', acessivel: true } });
    expect(r.classificacao).toBe('SITE_EXISTENTE');
    expect(r.url_site).toBe('https://a.com.br');
  });
  it('domínio que não responde vira PRESENCA_FRACA', () => {
    const r = classificarPresenca({ ...base, V3: { status: 'site_encontrado', url: 'https://b.com.br', acessivel: false } });
    expect(r.classificacao).toBe('PRESENCA_FRACA');
  });
});

describe('lead score', () => {
  const hoje = new Date('2026-11-12T00:00:00Z');
  it('sem evidência não pontua', () => {
    const r = calcularLeadScore({ classificacao: 'PENDENTE', hoje });
    expect(r.lead_score).toBe(0);
    expect(r.prioridade).toBe('baixa');
  });
  it('lead completo e verificado chega em alta prioridade com motivos', () => {
    const r = calcularLeadScore({
      classificacao: 'SOMENTE_REDES',
      situacaoReceitaAtiva: { valor: true, evidencia_id: 'r1' },
      presencaEmFonteAberta: { evidencia_id: 'o1' },
      telefoneComercial: { evidencia_id: 't1' },
      whatsappPublicado: { evidencia_id: 'w1' },
      avaliacoes: { quantidade: 84, evidencia_id: 'm1' },
      pontosSegmento: 8,
      hoje,
    });
    expect(r.lead_score).toBe(30 + 15 + 20 + 15 + 8);
    expect(r.prioridade).toBe('alta');
    expect(r.detalhe.find((l) => l.criterio === 'tracao')?.evidencia_ids).toEqual(['m1']);
  });
  it('tração por tempo de operação só para ME/EPP com 3+ anos', () => {
    const me = calcularLeadScore({ classificacao: 'SEM_SITE', dataAbertura: { data: '2020-01-01', evidencia_id: 'd' }, porte: { valor: 'ME', evidencia_id: 'p' }, hoje });
    const mei = calcularLeadScore({ classificacao: 'SEM_SITE', dataAbertura: { data: '2020-01-01', evidencia_id: 'd' }, porte: { valor: 'MEI', evidencia_id: 'p' }, hoje });
    expect(me.detalhe.find((l) => l.criterio === 'tracao')?.pontos).toBe(5);
    expect(mei.detalhe.find((l) => l.criterio === 'tracao')?.pontos).toBe(0);
  });
  it('tipo de oportunidade', () => {
    expect(tipoOportunidade('SEM_SITE')).toBe('A');
    expect(tipoOportunidade('PRESENCA_FRACA')).toBe('B');
    expect(tipoOportunidade('SITE_EXISTENTE')).toBeNull();
    expect(tipoOportunidade('SITE_EXISTENTE', 'C')).toBe('C');
    expect(tipoOportunidade('PENDENTE')).toBeNull();
  });
});
