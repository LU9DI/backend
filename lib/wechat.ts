/**
 * WeChat Pay — permanece DESLIGADO até ativação explícita.
 * Para ativar futuramente: WECHAT_ENABLED=true + credenciais válidas.
 */
import { resolvePlano } from '../stripeBilling.js';

function wechatEnabled(): boolean {
  return String(process.env.WECHAT_ENABLED || '').toLowerCase() === 'true';
}

export function wechatConfigured(): boolean {
  return wechatEnabled() && Boolean(
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
    enabled: wechatEnabled(),
    app_id_set: Boolean(process.env.WECHAT_APP_ID?.trim()),
    mch_id_set: Boolean(process.env.WECHAT_MCH_ID?.trim()),
    api_key_set: Boolean(process.env.WECHAT_API_KEY?.trim() || process.env.WECHAT_API_V3_KEY?.trim()),
    message: wechatConfigured() ? 'WeChat Pay habilitado' : 'WeChat Pay OFF',
  };
}

export async function createWechatOrder(opts: {
  planoKey: string;
  empresaId?: string | null;
  email?: string | null;
  openid?: string | null;
}): Promise<{ prepayId: string; codeUrl?: string | null; orderId: string; amount: number; label: string }> {
  if (!wechatConfigured()) throw new Error('WeChat Pay está desativado no Filtra.AI');
  const plano = resolvePlano(opts.planoKey);
  if (!plano) throw new Error('Plano inválido');
  const orderId = `wx_${plano.key}_${Date.now()}`;
  const amount = Number((plano.unitAmount / 100).toFixed(2));
  throw new Error(`WeChat Pay: integração ainda não ativada. order=${orderId} amount=${amount}`);
}
