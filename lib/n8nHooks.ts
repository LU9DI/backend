/**
 * Pontos de disparo n8n a partir dos fluxos internos (trial, review, pagamento).
 * Fire-and-forget — nunca quebra a requisição principal.
 */
import * as n8n from './n8n.js';

const dispatchN8nEvent = (n8n as unknown as {
  dispatchN8nEvent: (
    event: string,
    payload: Record<string, unknown>,
    context: { empresaId: string; slug?: string | null }
  ) => Promise<unknown>;
}).dispatchN8nEvent;

export function n8nOnTrialActivated(opts: {
  empresaId: string;
  slug: string;
  nomeEmpresa: string;
  email: string;
  expiraEm: string;
  whatsapp?: string | null;
}) {
  dispatchN8nEvent(
    'trial.activated',
    {
      empresa_id: opts.empresaId,
      slug: opts.slug,
      nome_empresa: opts.nomeEmpresa,
      email: opts.email,
      expira_em: opts.expiraEm,
      whatsapp: opts.whatsapp || null,
      painel_path: `/painel/${opts.slug}`,
      avaliacao_path: `/avaliacao/${opts.slug}`,
    },
    { empresaId: opts.empresaId, slug: opts.slug }
  ).catch(() => null);
}

export function n8nOnReview(opts: {
  empresaId: string;
  slug?: string | null;
  rating: number;
  name?: string;
  comment?: string;
  reviewId?: string | number;
  critical: boolean;
}) {
  const event = opts.critical ? 'review.critical' : 'review.created';
  dispatchN8nEvent(
    event,
    {
      empresa_id: opts.empresaId,
      slug: opts.slug || null,
      rating: opts.rating,
      name: opts.name || null,
      comment: (opts.comment || '').slice(0, 500),
      review_id: opts.reviewId ?? null,
      critical: opts.critical,
    },
    { empresaId: opts.empresaId, slug: opts.slug }
  ).catch(() => null);
}

export function n8nOnPaymentActivated(opts: {
  empresaId: string;
  slug?: string | null;
  plan: string;
  gateway?: string;
  expiraEm?: string;
}) {
  dispatchN8nEvent(
    'payment.activated',
    {
      empresa_id: opts.empresaId,
      slug: opts.slug || null,
      plan: opts.plan,
      gateway: opts.gateway || null,
      expira_em: opts.expiraEm || null,
    },
    { empresaId: opts.empresaId, slug: opts.slug }
  ).catch(() => null);
}
