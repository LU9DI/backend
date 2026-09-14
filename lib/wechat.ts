/**
 * WeChat Pay — stub. Ativo só com WECHAT_APP_ID / WECHAT_MCH_ID / WECHAT_API_KEY.
 */
export function wechatConfigured(): boolean {
  return Boolean(
    process.env.WECHAT_APP_ID?.trim() &&
      process.env.WECHAT_MCH_ID?.trim() &&
      process.env.WECHAT_API_KEY?.trim()
  );
}

export function wechatStatus() {
  return {
    configured: wechatConfigured(),
    enabled: process.env.WECHAT_ENABLED === '1',
  };
}
