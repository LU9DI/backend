/**
 * Validação de variáveis de ambiente na subida.
 * NÃO coloque secrets aqui — só process.env (Render Environment / .env).
 */

export type EnvReport = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

function stripeWanted(): boolean {
  const flag = String(process.env.STRIPE_ENABLED || '1').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

export function validateEnv(): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const jwt = process.env.JWT_SECRET || '';
  if (!jwt) {
    errors.push('JWT_SECRET é obrigatório (mín. 32 caracteres).');
  } else if (jwt.length < 32) {
    errors.push('JWT_SECRET deve ter pelo menos 32 caracteres.');
  }

  if (stripeWanted() && !process.env.STRIPE_SECRET_KEY?.trim()) {
    warnings.push(
      'STRIPE_SECRET_KEY ausente — cartão Stripe OFF. Use Pix (MP) ou PayPal, ou defina STRIPE_ENABLED=0.'
    );
  } else if (!stripeWanted()) {
    warnings.push('Stripe desligado (STRIPE_ENABLED=0) — pagamentos via Pix/PayPal.');
  }

  if (!process.env.MP_ACCESS_TOKEN?.trim()) {
    warnings.push('MP_ACCESS_TOKEN ausente — Pix (QR/copia-cola/recorrente) desligado.');
  }

  if (!process.env.PAYPAL_CLIENT_ID?.trim() || !process.env.PAYPAL_CLIENT_SECRET?.trim()) {
    warnings.push(
      'PayPal incompleto — precisa PAYPAL_CLIENT_ID e PAYPAL_CLIENT_SECRET (sandbox ou live).'
    );
  }

  const recovery = process.env.ADMIN_RECOVERY_SECRET || '';
  if (!recovery || recovery.length < 12) {
    warnings.push(
      'ADMIN_RECOVERY_SECRET ausente ou curta — recuperação de senha do admin fica desativada.'
    );
  }

  const hasGroq = Boolean(process.env.GROQ_API_KEY?.trim());
  const hasGemini = Boolean(
    process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim()
  );
  if (!hasGroq && !hasGemini) {
    warnings.push(
      'Nenhuma IA configurada (GROQ_API_KEY / GEMINI_API_KEY) — respostas automáticas desligadas.'
    );
  } else if (!hasGroq) {
    warnings.push('Só Gemini ativo — defina GROQ_API_KEY para usar Groq como primário.');
  } else if (!hasGemini) {
    warnings.push('Só Groq ativo — defina GEMINI_API_KEY para failover quando a cota acabar.');
  }

  if (!process.env.SMTP_HOST) {
    warnings.push('SMTP não configurado — links de reset aparecem só no log do servidor.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function assertEnvOrExit(): void {
  const report = validateEnv();
  for (const w of report.warnings) {
    console.warn(`⚠️  ${w}`);
  }
  if (!report.ok) {
    for (const e of report.errors) {
      console.error(`❌ ${e}`);
    }
    process.exit(1);
  }
}
