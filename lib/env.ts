/** Validação de env na subida. */

export type EnvReport = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

/** Stripe OFF por padrão (produto usa MP + PayPal). */
function stripeWanted(): boolean {
  const flag = String(process.env.STRIPE_ENABLED || '0').trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes';
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

  if (process.env.NODE_ENV === 'production') {
    const db =
      process.env.DATABASE_URL?.trim() ||
      process.env.SUPABASE_DB_URL?.trim() ||
      process.env.SUPABASE_DATABASE_URL?.trim();
    if (!db) {
      errors.push('DATABASE_URL ou SUPABASE_DB_URL obrigatório em produção.');
    }
  }

  if (stripeWanted() && !process.env.STRIPE_SECRET_KEY?.trim()) {
    warnings.push('STRIPE_SECRET_KEY ausente — Stripe OFF.');
  }

  if (!process.env.MP_ACCESS_TOKEN?.trim()) {
    warnings.push('MP_ACCESS_TOKEN ausente — Mercado Pago desligado.');
  }

  if (!process.env.PAYPAL_CLIENT_ID?.trim() || !process.env.PAYPAL_CLIENT_SECRET?.trim()) {
    warnings.push('PayPal incompleto (CLIENT_ID + SECRET).');
  }

  const recovery = process.env.ADMIN_RECOVERY_SECRET || '';
  if (!recovery || recovery.length < 12) {
    warnings.push('ADMIN_RECOVERY_SECRET curta — reset admin desativado.');
  }

  const hasGroq = Boolean(process.env.GROQ_API_KEY?.trim());
  const hasGemini = Boolean(
    process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim()
  );
  if (!hasGroq && !hasGemini) {
    warnings.push('Sem GROQ/GEMINI — IA desligada.');
  }

  if (!process.env.SMTP_HOST) {
    warnings.push('SMTP ausente — e-mails só no log.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function assertEnvOrExit(): void {
  const report = validateEnv();
  for (const w of report.warnings) console.warn(`⚠️  ${w}`);
  if (!report.ok) {
    for (const e of report.errors) console.error(`❌ ${e}`);
    process.exit(1);
  }
}
