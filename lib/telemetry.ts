import * as Sentry from '@sentry/node';
import type { Request, Response, NextFunction } from 'express';
import { Resend } from 'resend';
import { PostHog } from 'posthog-node';

/**
 * Initialize Sentry if DSN is provided via environment variable.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;
  Sentry.init({
    dsn,
    tracesSampleRate: 1.0,
    environment: process.env.NODE_ENV ?? 'production',
  });
}

/** Sentry request/response handlers – safe to use even if Sentry is not initialized. */
export const sentryRequestHandler = (Sentry as any).Handlers?.requestHandler?.() ?? ((req: Request, res: Response, next: NextFunction) => next());
export const sentryErrorHandler = (Sentry as any).Handlers?.errorHandler?.() ?? ((err: any, req: Request, res: Response, next: NextFunction) => next(err));

/** Resend email client – returns null when API key is missing. */
export const resendClient = (() => {
  const key = process.env.RESEND_API_KEY?.trim();
  return key ? new Resend(key) : null;
})();

/** PostHog analytics client – returns null when API key is missing. */
export const posthogClient = (() => {
  const apiKey = process.env.POSTHOG_API_KEY?.trim();
  if (!apiKey) return null;
  const host = process.env.POSTHOG_HOST?.trim() ?? 'https://app.posthog.com';
  return new PostHog(apiKey, { host });
})();

/** Capture an exception manually, honouring the current Sentry client state. */
export function captureException(error: unknown, context?: Record<string, any>): void {
  const hub = (Sentry as any).getCurrentHub?.();
  if (hub && hub.getClient?.()) {
    Sentry.captureException(error, { extra: context });
  }
}

/** Capture a custom message with optional level. */
export function captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  const hub = (Sentry as any).getCurrentHub?.();
  if (hub && hub.getClient?.()) {
    Sentry.captureMessage(message, level);
  }
}
