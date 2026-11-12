export const VERSAO_MOTOR = 'prospecting@0.1.0';

export interface ConfigMotor {
  databaseUrl: string;
  centralUrl: string;
  centralApiKey: string;
  tavilyApiKey: string | null;
  tavilyLimiteMensal: number;
  exaApiKey: string | null;
  exaLimiteMensal: number;
  exaTipo: string;
  /** Score estimado mínimo para gastar busca web (V5). */
  scoreMinimoBuscaWeb: number;
  /** Não reprocessa uma empresa verificada há menos de N dias (economiza cota). */
  diasReprocessamento: number;
  concorrencia: number;
  userAgent: string;
}

function num(v: string | undefined, padrao: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v != null ? n : padrao;
}

export function lerConfigMotor(env: NodeJS.ProcessEnv = process.env): ConfigMotor {
  const faltando = ['DATABASE_URL', 'CENTRAL_URL', 'CENTRAL_API_KEY'].filter((k) => !env[k]);
  if (faltando.length) throw new Error(`variáveis ausentes: ${faltando.join(', ')}`);
  return {
    databaseUrl: env.DATABASE_URL!,
    centralUrl: env.CENTRAL_URL!.replace(/\/+$/, ''),
    centralApiKey: env.CENTRAL_API_KEY!,
    tavilyApiKey: env.TAVILY_API_KEY || null,
    // Plano gratuito do Tavily: 1.000 créditos/mês; busca básica = 1 crédito. Margem de segurança.
    tavilyLimiteMensal: num(env.TAVILY_LIMITE_MENSAL, 950),
    exaApiKey: env.EXA_API_KEY || null,
    // US$ 10/mês grátis. Ajuste conforme o tipo de busca e o preço vigente na exa.ai/pricing.
    exaLimiteMensal: num(env.EXA_LIMITE_MENSAL, 1300),
    exaTipo: env.EXA_TIPO || 'auto',
    scoreMinimoBuscaWeb: num(env.SCORE_MINIMO_BUSCA_WEB, 45),
    diasReprocessamento: num(env.DIAS_REPROCESSAMENTO, 30),
    concorrencia: num(env.CONCORRENCIA, 4),
    userAgent: env.USER_AGENT || 'IONEXT-ProspectIntelligence/0.1 (+https://ionext.com.br)',
  };
}
