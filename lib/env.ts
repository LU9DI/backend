import 'dotenv/config';

/**
 * Validação de variáveis de ambiente na subida.
 * Em produção: JWT forte + DATABASE_URL Postgres (exceto SQLITE_ALLOW_PROD=1).
 */

export type EnvReport = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export function isProductionRuntime(): boolean {
  const timeline = (process.env.DENO_TIMELINE || '').trim();
  return process.env.NODE_ENV === 'production' ||
    (process.env.DENO_DEPLOY === 'true' && timeline === 'production');
}

export function validateEnv(): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const timeline = (process.env.DENO_TIMELINE || '').trim();
  const isDenoDeploy = process.env.DENO_DEPLOY === 'true';
  const isDenoProduction = isDenoDeploy && timeline === 'production';
  const isProd = process.env.NODE_ENV === 'production' || isDenoProduction;

  // Deno Deploy usa contextos separados: Production e Development.
  // Preview/branch são Development timelines e não devem exigir NODE_ENV=production.
  if (isDenoProduction && process.env.NODE_ENV !== 'production') {
    errors.push('NODE_ENV=production é obrigatório na timeline Production do Deno Deploy.');
  }

  const jwt = process.env.JWT_SECRET || '';
  if (!jwt) {
    errors.push('JWT_SECRET é obrigatório (mín. 32 caracteres).');
  } else if (jwt.length < 32) {
    errors.push('JWT_SECRET deve ter pelo menos 32 caracteres.');
  } else if (isProd && /^(secret|change|troque|test|dev)/i.test(jwt)) {
    errors.push('JWT_SECRET em produção parece placeholder — use um valor aleatório forte.');
  }

  const dbUrl = process.env.DATABASE_URL?.trim() || '';
  const useSupabaseDb = process.env.USE_SUPABASE_DB === '1';
  const allowSqliteProd = process.env.SQLITE_ALLOW_PROD === '1';
  if (isProd && !allowSqliteProd) {
    if (useSupabaseDb) {
      if (!process.env.SUPABASE_DB_PASSWORD?.trim() || !process.env.SUPABASE_DB_HOST?.trim() || !process.env.SUPABASE_DB_USER?.trim()) {
        errors.push('USE_SUPABASE_DB=1 exige SUPABASE_DB_PASSWORD, SUPABASE_DB_HOST e SUPABASE_DB_USER.');
      }
    } else if (!dbUrl) {
      errors.push(
        'DATABASE_URL (PostgreSQL) é obrigatório em produção. ' +
          'Defina USE_SUPABASE_DB=1 para usar o Postgres do Supabase.'
      );
    } else if (!/^postgres(ql)?:\/\//i.test(dbUrl)) {
      errors.push('DATABASE_URL deve ser uma URL postgres:// ou postgresql://.');
    }
  }

  if (isProd && !String(process.env.ADMIN_PASSWORD || '').trim()) {
    errors.push('ADMIN_PASSWORD é obrigatório em produção para criar o primeiro admin.');
  }

  if (isProd) {
    const webauthnRpId = process.env.WEBAUTHN_RP_ID?.trim() || '';
    const webauthnOrigin = process.env.WEBAUTHN_ORIGIN?.trim() || '';
    if (!webauthnRpId || !webauthnOrigin) {
      errors.push('WEBAUTHN_RP_ID e WEBAUTHN_ORIGIN são obrigatórios em produção.');
    } else if (/^localhost(?:\.|$)/i.test(webauthnRpId) || /^http:\/\/localhost(?::|$)/i.test(webauthnOrigin)) {
      errors.push('WebAuthn em produção não pode usar localhost como RP ID/origin.');
    }
  }

  if (isProd) {
    const cors =
      (process.env.CORS_ORIGINS || '').trim() ||
      process.env.APP_URL ||
      process.env.FRONTEND_URL;
    if (!cors) {
      warnings.push(
        'CORS_ORIGINS / APP_URL / FRONTEND_URL vazios em produção — browsers de outros domínios serão bloqueados.'
      );
    }
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    warnings.push('STRIPE_SECRET_KEY ausente — checkout cartão retornará 503 até configurar.');
  }

  if (!process.env.MP_ACCESS_TOKEN?.trim()) {
    warnings.push('MP_ACCESS_TOKEN ausente — Pix desligado.');
  }

  if (!process.env.PAYPAL_CLIENT_ID?.trim()) {
    warnings.push('PAYPAL_CLIENT_ID ausente — PayPal desligado.');
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
    warnings.push('Só Gemini ativo — defina GROQ_API_KEY para primário.');
  } else if (!hasGemini) {
    warnings.push('Só Groq ativo — defina GEMINI_API_KEY para failover de cota.');
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
