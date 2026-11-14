/**
 * Motor 02 · auditoria de sites.
 *   worker                 pede trabalho à Central, audita e devolve o diagnóstico (fica rodando)
 *   auditar --url <url>    audita um site e mostra o resultado (não grava nada)
 */
import { parseArgs } from 'node:util';
import { carregarEnv } from '@ionext/dominio';
import { auditar } from './auditar.ts';
import { ClienteCentral } from './central.ts';
import { lerConfigAudit } from './config.ts';
import { navegacaoReal } from './crawler.ts';
import { ErroTemporario, psiReal } from './psi.ts';

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  carregarEnv();
  const [comando, ...resto] = process.argv.slice(2);
  const { values: a } = parseArgs({ args: resto, strict: false, options: { url: { type: 'string' } } });

  if (comando === 'auditar') {
    const url = typeof a.url === 'string' ? a.url : null;
    if (!url) throw new Error('--url obrigatório');
    const nav = navegacaoReal('IONEXT-Auditoria/0.1 (+https://ionext.com.br)');
    const d = await auditar({ empresa_id: '00000000-0000-0000-0000-000000000000', url, tentativas: 99 },
      { nav, psi: psiReal(process.env.PAGESPEED_API_KEY || null), tentativasPsi: 0 });
    const { psi, ...semPrints } = d;
    console.log(JSON.stringify({ ...semPrints, psi: { mobile: psi.mobile && { ...psi.mobile, screenshot: psi.mobile.screenshot ? '(imagem)' : null }, desktop: psi.desktop && { ...psi.desktop, screenshot: psi.desktop.screenshot ? '(imagem)' : null } } }, null, 2));
    return;
  }

  if (comando === 'worker') {
    const config = lerConfigAudit();
    const central = new ClienteCentral(config.centralUrl, config.centralApiKey);
    const nav = navegacaoReal(config.userAgent);
    const psi = psiReal(config.pagespeedApiKey);
    const estado = { auditadas: 0, falhas: 0, na_fila: 0, ultima: null as string | null, ultimo_erro: null as string | null, pagespeed: config.pagespeedApiKey ? 'com chave' : 'sem chave' };
    let parar = false;
    process.on('SIGINT', () => { parar = true; });
    process.on('SIGTERM', () => { parar = true; });
    const sinalDeVida = async () => { try { await central.status({ ...estado }); } catch { /* Central subindo */ } };
    setInterval(sinalDeVida, 30_000);
    log(`motor de auditoria no ar (PageSpeed ${estado.pagespeed}, ${config.concorrencia} por vez)`);
    await esperar(4_000);

    while (!parar) {
      let itens: Awaited<ReturnType<ClienteCentral['reservar']>>['itens'] = [];
      try {
        const r = await central.reservar(config.concorrencia);
        itens = r.itens; estado.na_fila = r.na_fila;
      } catch (e) {
        log(`aguardando a Central (${(e as Error).message.slice(0, 120)})`);
      }
      if (itens.length === 0) { await sinalDeVida(); await esperar(config.intervaloSegundos * 1000); continue; }

      let pausarPorCota = false;
      await Promise.all(itens.map(async (p) => {
        const t0 = Date.now();
        try {
          const d = await auditar(p, { nav, psi, tentativasPsi: config.tentativasPsi });
          const r = await central.enviar(d);
          estado.auditadas++; estado.ultima = new Date().toISOString();
          log(`${p.nome_fantasia}: classe ${r.classe} (${d.achados.filter((x) => x.gravidade === 'grave').length} graves) em ${Math.round((Date.now() - t0) / 1000)} s`);
        } catch (e) {
          const msg = (e as Error).message;
          estado.falhas++; estado.ultimo_erro = msg.slice(0, 200);
          if (e instanceof ErroTemporario) pausarPorCota = true;
          log(`${p.nome_fantasia}: falhou (${msg.slice(0, 160)}); volta para a fila`);
          try { await central.falhou(p.empresa_id, msg); } catch { /* a reserva expira sozinha */ }
        }
      }));
      await sinalDeVida();
      // sem cota no PageSpeed: dá um tempo antes de pedir mais
      await esperar(pausarPorCota ? 120_000 : 3_000);
    }
    process.exit(0);
  }

  console.log('uso: worker | auditar --url https://site.com.br');
}

main().catch((e) => { console.error(e); process.exit(1); });
