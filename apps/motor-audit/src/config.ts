export const VERSAO_MOTOR = 'audit@0.1.0';

export interface ConfigAudit {
  centralUrl: string;
  centralApiKey: string;
  pagespeedApiKey: string | null;
  /** Auditorias ao mesmo tempo (o PageSpeed sem chave aguenta pouco). */
  concorrencia: number;
  /** Depois de N tentativas com o PageSpeed falhando, audita só pelo HTML. */
  tentativasPsi: number;
  intervaloSegundos: number;
  userAgent: string;
}

export function lerConfigAudit(env: NodeJS.ProcessEnv = process.env): ConfigAudit {
  const chave = env.CENTRAL_API_KEY_AUDIT || env.CENTRAL_API_KEY;
  const faltando = [!env.CENTRAL_URL && 'CENTRAL_URL', !chave && 'CENTRAL_API_KEY'].filter(Boolean);
  if (faltando.length) throw new Error(`variáveis ausentes: ${faltando.join(', ')}`);
  const num = (v: string | undefined, p: number) => (v && Number.isFinite(Number(v)) ? Number(v) : p);
  const comChave = !!env.PAGESPEED_API_KEY;
  return {
    centralUrl: env.CENTRAL_URL!.replace(/\/+$/, ''),
    centralApiKey: chave!,
    pagespeedApiKey: env.PAGESPEED_API_KEY || null,
    concorrencia: num(env.AUDIT_CONCORRENCIA, comChave ? 2 : 1),
    tentativasPsi: num(env.AUDIT_TENTATIVAS_PSI, 4),
    intervaloSegundos: num(env.AUDIT_INTERVALO, comChave ? 20 : 60),
    userAgent: env.AUDIT_USER_AGENT || 'IONEXT-Auditoria/0.1 (+https://ionext.com.br)',
  };
}
