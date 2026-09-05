/** Lista faturas Stripe (admin). */

const STRIPE_API = 'https://api.stripe.com/v1';

export async function listStripeInvoices(limit = 30): Promise<{
  configured: boolean;
  invoices: any[];
  error?: string;
}> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return { configured: false, invoices: [], error: 'STRIPE_SECRET_KEY ausente' };

  try {
    const url = `${STRIPE_API}/invoices?limit=${Math.min(100, Math.max(1, limit))}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await res.json();
    if (!res.ok) {
      return {
        configured: true,
        invoices: [],
        error: data?.error?.message || `Stripe ${res.status}`,
      };
    }
    const invoices = (data.data || []).map((inv: any) => ({
      id: inv.id,
      number: inv.number,
      status: inv.status,
      customer_email: inv.customer_email,
      customer_name: inv.customer_name,
      amount_due: (inv.amount_due || 0) / 100,
      amount_paid: (inv.amount_paid || 0) / 100,
      currency: inv.currency,
      created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
      due_date: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
      hosted_invoice_url: inv.hosted_invoice_url,
      metadata: inv.metadata || {},
    }));
    return { configured: true, invoices };
  } catch (e: any) {
    return { configured: true, invoices: [], error: e?.message || 'Falha Stripe' };
  }
}
