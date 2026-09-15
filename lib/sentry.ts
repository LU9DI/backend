/**
 * Sentry opcional — só ativa se SENTRY_DSN estiver definido
 * e o pacote @sentry/node estiver instalado.
 *
 * Env:
 *   SENTRY_DSN=https://...
 *   SENTRY_TRACES_SAMPLE_RATE=0.05
 */
export async function initSentryOptional(): Promise<boolean> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    console.log('📡 Sentry OFF (defina SENTRY_DSN para ligar)');
    return false;
  }

  try {
    const Sentry = await import('@sentry/node').catch(() => null);
    if (!Sentry) {
      console.warn(
        '⚠️  SENTRY_DSN definido, mas @sentry/node não está instalado. npm i @sentry/node'
      );
      return false;
    }

    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: Math.min(
        1,
        Math.max(0, Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.05))
      ),
      release: process.env.RENDER_GIT_COMMIT || process.env.npm_package_version || undefined,
    });

    (global as any).__filtra_sentry = Sentry;
    console.log('📡 Sentry ON');
    return true;
  } catch (e: any) {
    console.warn('Sentry init falhou:', e?.message || e);
    return false;
  }
}

export function captureException(err: unknown, extra?: Record<string, unknown>) {
  try {
    const Sentry = (global as any).__filtra_sentry;
    if (!Sentry?.captureException) return;
    if (extra) {
      Sentry.withScope?.((scope: any) => {
        for (const [k, v] of Object.entries(extra)) scope.setExtra?.(k, v);
        Sentry.captureException(err);
      });
    } else {
      Sentry.captureException(err);
    }
  } catch {
    /* ok */
  }
}
