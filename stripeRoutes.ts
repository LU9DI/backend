/**
 * Rotas Stripe isoladas.
 * Política de cancelamento (assinatura mensal):
 * - Pode cancelar a qualquer momento.
 * - O acesso permanece até o fim do período já pago (current_period_end).
 * - Só então o status passa a bloqueado (após expira_em).
 */
import type { Express, Request, Response } from 'express';
import type { Database } from 'sqlite';
import express from 'express';
import {
  stripeConfigured,
  criarCheckoutSession,
  criarPortalSession,
  constructStripeEvent,
  extractFromStripeObject,
  resolvePlano,
  listPlanosPublicos,
} from './stripeBilling.js';

async function ensureStripeColumns(db: Database) {
  const cols = (await db.all(`PRAGMA table_info(empresas)`)).map((c: any) => c.name);
  if (!cols.includes('stripe_customer_id')) {
    await db.exec(`ALTER TABLE empresas ADD COLUMN stripe_customer_id TEXT`);
  }
  if (!cols.includes('stripe_subscription_id')) {
    await db.exec(`ALTER TABLE empresas ADD COLUMN stripe_subscription_id TEXT`);
  }
  if (!cols.includes('cancel_at_period_end')) {
    await db.exec(`ALTER TABLE empresas ADD COLUMN cancel_at_period_end INTEGER DEFAULT 0`);
  }
}

function fromUnix(sec: unknown): string | null {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function periodEndFromStripe(obj: any): string | null {
  return (
    fromUnix(obj?.current_period_end) ||
    fromUnix(obj?.items?.data?.[0]?.current_period_end) ||
    null
  );
}

async function activatePlan(
  db: Database,
  empresaId: string,
  planDb: string,
  customerId?: string | null,
  subscriptionId?: string | null,
  periodEndIso?: string | null
) {
  const normalized =
    planDb === 'corporativo' || planDb === 'corporate'
      ? 'corporate'
      : planDb === 'ultra'
        ? 'ultra'
        : 'pro';

  const expira =
    periodEndIso ||
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await db.run(
    `UPDATE empresas SET status = 'ativo', plan = ?, expira_em = ?, cancel_at_period_end = 0 WHERE id = ?`,
    [normalized, expira, empresaId]
  );
  if (customerId) {
    await db.run(`UPDATE empresas SET stripe_customer_id = ? WHERE id = ?`, [customerId, empresaId]);
  }
  if (subscriptionId) {
    await db.run(`UPDATE empresas SET stripe_subscription_id = ? WHERE id = ?`, [
      subscriptionId,
      empresaId,
    ]);
  }
}

/** Cancelamento solicitado: mantém status ativo até expira_em. */
async function markCancelAtPeriodEnd(
  db: Database,
  empresaId: string,
  periodEndIso: string | null
) {
  if (periodEndIso) {
    await db.run(
      `UPDATE empresas SET cancel_at_period_end = 1, expira_em = ?, status = 'ativo' WHERE id = ?`,
      [periodEndIso, empresaId]
    );
  } else {
    await db.run(
      `UPDATE empresas SET cancel_at_period_end = 1, status = 'ativo' WHERE id = ?`,
      [empresaId]
    );
  }
}

async function blockEmpresa(db: Database, empresaId: string) {
  await db.run(
    `UPDATE empresas SET status = 'bloqueado', cancel_at_period_end = 0 WHERE id = ?`,
    [empresaId]
  );
}

export function empresaTemAcesso(empresa: {
  status?: string;
  expira_em?: string | null;
}): boolean {
  const status = String(empresa?.status || '');
  const agora = Date.now();
  const fim = empresa?.expira_em ? new Date(empresa.expira_em).getTime() : null;

  // ativo/trial: liberado enquanto não passou expira_em
  if (status === 'ativo' || status === 'trial') {
    if (fim == null || Number.isNaN(fim)) return true;
    return agora <= fim;
  }
  return false;
}

/** Bloqueia só depois de expira_em quando houve cancelamento no fim do ciclo. */
export async function enforcarExpiracoes(db: Database) {
  const agora = new Date().toISOString();
  // Cancelados no fim do ciclo
  await db.run(
    `UPDATE empresas
     SET status = 'bloqueado', cancel_at_period_end = 0
     WHERE status = 'ativo'
       AND cancel_at_period_end = 1
       AND expira_em IS NOT NULL
       AND expira_em < ?`,
    [agora]
  );
  // Trial ou ativo com prazo vencido (sem renovação)
  await db.run(
    `UPDATE empresas
     SET status = 'bloqueado'
     WHERE status IN ('trial', 'ativo')
       AND cancel_at_period_end = 0
       AND expira_em IS NOT NULL
       AND expira_em < ?`,
    [agora]
  );
}

async function resolveEmpresaId(
  db: Database,
  empresaId: string | null,
  customerId: string | null
): Promise<string | null> {
  if (empresaId) return empresaId;
  if (!customerId) return null;
  const row = await db.get('SELECT id FROM empresas WHERE stripe_customer_id = ?', [customerId]);
  return row?.id || null;
}

function formatarDataBR(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

export function mensagemAcesso(empresa: any): string | null {
  if (!empresa) return null;
  const ate = formatarDataBR(empresa.expira_em);
  if (Number(empresa.cancel_at_period_end) === 1 && ate) {
    return `Assinatura cancelada. Você tem direito de usar o sistema até ${ate}, último dia do período já pago. Após essa data o acesso será encerrado automaticamente.`;
  }
  if (empresa.status === 'trial' && ate) {
    return `Período de testes ativo até ${ate}.`;
  }
  if (empresa.status === 'ativo' && ate) {
    return `Licença ativa. Próxima renovação / validade até ${ate}.`;
  }
  if (empresa.status === 'bloqueado') {
    return 'Acesso encerrado. Renove a assinatura para continuar.';
  }
  return null;
}

export function mountStripeRoutes(app: Express, getDb: () => Database) {
  app.post(
    '/api/webhook/stripe',
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      try {
        const sig = req.headers['stripe-signature'] as string | undefined;
        const raw = req.body as Buffer;
        const event = constructStripeEvent(raw, sig);
        const db = getDb();
        await ensureStripeColumns(db);
        await enforcarExpiracoes(db);

        const type = String(event.type || '');
        const obj = event.data?.object || {};

        if (type === 'customer.subscription.updated') {
          let { empresaId, planDb, customerId, subscriptionId } =
            extractFromStripeObject(obj);
          empresaId = await resolveEmpresaId(db, empresaId, customerId);
          const periodEnd = periodEndFromStripe(obj);
          const stripeStatus = String(obj.status || '');

          // Cancelamento solicitado → NÃO bloquear; só marcar e fixar expira_em
          if (obj.cancel_at_period_end === true && empresaId) {
            await markCancelAtPeriodEnd(db, empresaId, periodEnd);
            return res.json({ ok: true, action: 'cancel_at_period_end' });
          }

          if (stripeStatus === 'canceled' && empresaId) {
            // Ainda dentro do período pago → manter acesso
            if (periodEnd && new Date(periodEnd).getTime() > Date.now()) {
              await markCancelAtPeriodEnd(db, empresaId, periodEnd);
              return res.json({ ok: true, action: 'grace_until_period_end' });
            }
            await blockEmpresa(db, empresaId);
            return res.json({ ok: true, action: 'block' });
          }

          if (stripeStatus === 'active' && empresaId) {
            const resolved = resolvePlano(planDb || obj.metadata?.plan_db || 'pro');
            await activatePlan(
              db,
              empresaId,
              resolved?.planDb || planDb || 'pro',
              customerId,
              subscriptionId,
              periodEnd
            );
            return res.json({ ok: true, action: 'activate' });
          }
        }

        if (
          type === 'checkout.session.completed' ||
          type === 'customer.subscription.created' ||
          type === 'invoice.paid'
        ) {
          let { empresaId, planDb, customerId, subscriptionId } =
            extractFromStripeObject(obj);
          empresaId = await resolveEmpresaId(db, empresaId, customerId);
          const periodEnd = periodEndFromStripe(obj);

          if (
            type === 'checkout.session.completed' &&
            obj.payment_status &&
            obj.payment_status !== 'paid' &&
            obj.payment_status !== 'no_payment_required'
          ) {
            return res.json({ ok: true, action: 'pending' });
          }

          if (empresaId && (planDb || type === 'invoice.paid')) {
            const resolved = resolvePlano(planDb || 'pro');
            await activatePlan(
              db,
              empresaId,
              resolved?.planDb || planDb || 'pro',
              customerId,
              subscriptionId,
              periodEnd
            );
            return res.json({ ok: true, action: 'activate' });
          }
        }

        // Fim da assinatura no Stripe: só bloqueia se o período pago já acabou
        if (type === 'customer.subscription.deleted') {
          let { empresaId, customerId } = extractFromStripeObject(obj);
          empresaId = await resolveEmpresaId(db, empresaId, customerId);
          const periodEnd = periodEndFromStripe(obj);
          if (empresaId) {
            if (periodEnd && new Date(periodEnd).getTime() > Date.now()) {
              await markCancelAtPeriodEnd(db, empresaId, periodEnd);
              return res.json({ ok: true, action: 'grace_until_period_end' });
            }
            // Sem period_end futuro: consulta expira_em no banco
            const emp = await db.get('SELECT expira_em FROM empresas WHERE id = ?', [empresaId]);
            if (emp?.expira_em && new Date(emp.expira_em).getTime() > Date.now()) {
              await markCancelAtPeriodEnd(db, empresaId, emp.expira_em);
              return res.json({ ok: true, action: 'grace_db_expira_em' });
            }
            await blockEmpresa(db, empresaId);
            return res.json({ ok: true, action: 'block_period_ended' });
          }
        }

        if (type === 'charge.refunded') {
          let { empresaId, customerId } = extractFromStripeObject(obj);
          empresaId = await resolveEmpresaId(db, empresaId, customerId);
          if (empresaId) {
            await blockEmpresa(db, empresaId);
            return res.json({ ok: true, action: 'block_refund' });
          }
        }

        res.json({ ok: true, action: 'ignore' });
      } catch (e: any) {
        console.error('Stripe webhook:', e.message || e);
        res.status(400).json({ error: e.message || 'Webhook error' });
      }
    }
  );

  app.get('/api/planos', (_req, res) => {
    res.json({
      stripe: stripeConfigured(),
      planos: listPlanosPublicos(),
      politica_cancelamento:
        'A assinatura mensal poderá ser cancelada a qualquer momento. Em caso de cancelamento antes do término do ciclo, o acesso permanece ativo até o último dia do período já pago — sem cobrança adicional no mês seguinte.',
    });
  });

  /** Status de assinatura para o painel (mensagem de uso até o fim do mês). */
  app.get('/api/empresa/:ref/assinatura', async (req: Request, res: Response) => {
    try {
      const db = getDb();
      await ensureStripeColumns(db);
      await enforcarExpiracoes(db);

      let empresa = await db.get('SELECT * FROM empresas WHERE id = ?', [req.params.ref]);
      if (!empresa) {
        empresa = await db.get('SELECT * FROM empresas WHERE slug = ?', [req.params.ref]);
      }
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

      const temAcesso = empresaTemAcesso(empresa);
      const cancelado = Number(empresa.cancel_at_period_end) === 1;
      const msg = mensagemAcesso(empresa);

      res.json({
        status: empresa.status,
        plan: empresa.plan,
        expira_em: empresa.expira_em,
        expira_em_formatado: formatarDataBR(empresa.expira_em),
        cancel_at_period_end: cancelado,
        tem_acesso: temAcesso,
        mensagem: msg,
        aviso_cancelamento: cancelado
          ? `Você solicitou o cancelamento. O uso permanece liberado até ${formatarDataBR(empresa.expira_em) || 'o fim do período já pago'}. O bloqueio será automático após essa data.`
          : null,
      });
    } catch (e: any) {
      console.error('assinatura:', e.message || e);
      res.status(500).json({ error: 'Erro interno do servidor.' });
    }
  });

  app.post('/api/checkout', async (req: Request, res: Response) => {
    try {
      if (!stripeConfigured()) {
        return res.status(503).json({
          error: 'Pagamentos não configurados (STRIPE_SECRET_KEY).',
        });
      }
      const plano = String(req.body.plano || req.body.plan || '').toLowerCase();
      if (!resolvePlano(plano)) {
        return res.status(400).json({ error: 'Plano inválido.' });
      }

      const empresaId = req.body.empresa_id ? String(req.body.empresa_id) : null;
      const db = getDb();
      await ensureStripeColumns(db);

      let nomeEmpresa: string | null = null;
      if (empresaId) {
        const emp = await db.get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
        if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
        nomeEmpresa = emp.nome_empresa;
      }

      const session = await criarCheckoutSession({
        planoKey: plano,
        empresaId,
        email: req.body.email ? String(req.body.email) : null,
        nomeEmpresa,
      });

      res.json({
        success: true,
        checkout_url: session.checkoutUrl,
        session_id: session.sessionId,
        plano: session.label,
        value: session.value,
      });
    } catch (e: any) {
      console.error('Checkout:', e.message || e);
      res.status(500).json({ error: e.message || 'Erro no checkout' });
    }
  });

  app.post('/api/billing-portal', async (req: Request, res: Response) => {
    try {
      if (!stripeConfigured()) {
        return res.status(503).json({ error: 'Pagamentos não configurados.' });
      }
      const empresaId = String(req.body.empresa_id || '').trim();
      if (!empresaId) return res.status(400).json({ error: 'empresa_id obrigatório.' });

      const db = getDb();
      const emp = await db.get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
      if (!emp) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!emp.stripe_customer_id) {
        return res.status(400).json({
          error: 'Esta empresa ainda não possui assinatura Stripe. Conclua um checkout primeiro.',
        });
      }

      const portal = await criarPortalSession(emp.stripe_customer_id);
      res.json({ success: true, url: portal.url });
    } catch (e: any) {
      console.error('Portal:', e.message || e);
      res.status(500).json({ error: e.message || 'Erro no portal' });
    }
  });

  // Job horário: bloqueia só após expira_em
  const timer = setInterval(() => {
    try {
      const db = getDb();
      enforcarExpiracoes(db).catch(() => {});
    } catch {
      /* db ainda não pronto */
    }
  }, 60 * 60 * 1000);
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref();
  }
}
