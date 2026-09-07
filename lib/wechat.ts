/**
 * WeChat Pay — esqueleto (OFF até configurar credenciais).
 *
 * Mesmo padrão do Stripe/PayPal: sem chaves → wechatConfigured() === false
 * e as rotas respondem 503, sem quebrar o resto da API.
 *
 * Env (quando for ligar de verdade):
 *   WECHAT_APP_ID=
 *   WECHAT_MCH_ID=          (merchant id)
 *   WECHAT_API_KEY=         (API v3 key)
 *   WECHAT_SERIAL_NO=       (cert serial)
 *   WECHAT_PRIVATE_KEY_PATH= (ou WECHAT_PRIVATE_KEY= PEM)
 *   WECHAT_NOTIFY_URL=      (webhook)
 *   WECHAT_MODE=sandbox|live
 *
 * Nota: WeChat Pay exige conta merchant na China e certificados.
 * Esta camada só prepara o contrato; a implementação completa
 * (assinatura RSA, unified order, notify) fica para quando as chaves existirem.
 */

import { resolvePlano } from '../stripeBilling.js';

export function wechatConfigured(): boolean {
  return Boolean(
    process.env.WECHAT_APP_ID?.trim() &&
      process.env.WECHAT_MCH_ID?.trim() &&
      (process.env.WECHAT_API_KEY?.trim() || process.env.WECHAT_API_V3_KEY?.trim())
  );
}

export function wechatStatus() {
  return {
    configured: wechatConfigured(),
    provider: 'wechat_pay',
    mode: (process.env.WECHAT_MODE || 'sandbox').toLowerCase(),
    app_id_set: Boolean(process.env.WECHAT_APP_ID?.trim()),
    mch_id_set: Boolean(process.env.WECHAT_MCH_ID?.trim()),
    api_key_set: Boolean(
      process.env.WECHAT_API_KEY?.trim() || process.env.WECHAT_API_V3_KEY?.trim()
    ),
    message: wechatConfigured()
      ? 'WeChat Pay habilitado'
      : 'WeChat Pay OFF — defina WECHAT_APP_ID, WECHAT_MCH_ID e WECHAT_API_KEY',
  };
}

/**
 * Cria ordem WeChat Pay (native / JSAPI).
 * Enquanto não houver SDK completo, só valida plano e lança se não configurado.
 */
export async function createWechatOrder(opts: {
  planoKey: string;
  empresaId?: string | null;
  email?: string | null;
  openid?: string | null;
}): Promise<{
  prepayId: string;
  codeUrl?: string | null;
  orderId: string;
  amount: number;
  label: string;
}> {
  if (!wechatConfigured()) {
    throw new Error(
      'WeChat Pay não configurado. Defina WECHAT_APP_ID, WECHAT_MCH_ID e WECHAT_API_KEY no Render.'
    );
  }

  const plano = resolvePlano(opts.planoKey);
  if (!plano) throw new Error('Plano inválido');

  // Placeholder: integração real exigiria signed request à API WeChat Pay v3.
  // Mantém o contrato estável para o front / admin.
  const orderId = `wx_${plano.key}_${Date.now()}`;
  const amount = Number((plano.unitAmount / 100).toFixed(2));

  // Em produção real: POST /v3/pay/transactions/native|jsapi
  // e retornar code_url (QR) ou parâmetros JSAPI.
  throw new Error(
    'WeChat Pay: credenciais detectadas, mas a integração unificada ainda não está ligada. ' +
      'Contate o time para ativar unified order (native/JSAPI). order=' +
      orderId +
      ` amount=${amount}`
  );
}
