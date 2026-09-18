/** Rotas Stripe isoladas. */
import type { Express, Request, Response } from 'express';
import type { Database } from 'sqlite';
import express from 'express';
import { stripeConfigured, criarCheckoutSession, criarPortalSession, constructStripeEvent, extractFromStripeObject, resolvePlano } from './stripeBilling.js';
import { validateBody, schemaCheckout } from './middleware/validate.js';
import { activatePlan, markCancelAtPeriodEnd, blockEmpresa, empresaTemAcesso, enforcarExpiracoes } from './services/billingService.js';
import { logWebhookEvent } from './lib/opsLog.js';
import { claimWebhookEvent, releaseWebhookEvent, updateWebhookAction } from './lib/webhookIdempotency.js';
import { autenticarToken, isAdminUser, empresaInformadaPertenceAoToken, type AuthRequest } from './lib/auth.js';
import { createFiscalDocumentForPayment } from './lib/fiscal.js';
async function ensureStripeColumns(db:Database){try{const cols=(await db.all(`PRAGMA table_info(empresas)`)).map((c:any)=>c.name);if(!cols.includes('stripe_customer_id'))await db.exec(`ALTER TABLE empresas ADD COLUMN stripe_customer_id TEXT`);if(!cols.includes('stripe_subscription_id'))await db.exec(`ALTER TABLE empresas ADD COLUMN stripe_subscription_id TEXT`);if(!cols.includes('cancel_at_period_end'))await db.exec(`ALTER TABLE empresas ADD COLUMN cancel_at_period_end INTEGER DEFAULT 0`);}catch{for(const ddl of [`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`,`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`,`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS cancel_at_period_end INTEGER DEFAULT 0`]){try{await db.exec(ddl);}catch{}}}}
function fromUnix(sec:unknown):string|null{const n=Number(sec);return Number.isFinite(n)&&n>0?new Date(n*1000).toISOString():null;}
function periodEndFromStripe(obj:any):string|null{return fromUnix(obj?.current_period_end)||fromUnix(obj?.items?.data?.[0]?.current_period_end)||null;}
async function resolveEmpresaId(db:Database,empresaId:string|null,customerId:string|null):Promise<string|null>{if(empresaId)return empresaId;if(!customerId)return null;const row=await db.get('SELECT id FROM empresas WHERE stripe_customer_id=?',[customerId]);return row?.id||null;}
function formatarDataBR(iso:string|null|undefined):string|null{if(!iso)return null;const d=new Date(iso);return Number.isNaN(d.getTime())?null:d.toLocaleDateString('pt-BR',{day:'2-digit',month:'long',year:'numeric'});}
export function mensagemAcesso(empresa:any):string|null{if(!empresa)return null;const ate=formatarDataBR(empresa.expira_em);if(Number(empresa.cancel_at_period_end)===1&&ate)return`Assinatura cancelada. Você tem direito de usar o sistema até ${ate}, último dia do período já pago. Após essa data o acesso será encerrado automaticamente.`;if(empresa.status==='trial'&&ate)return`Período de testes ativo até ${ate}.`;if(empresa.status==='ativo'&&ate)return`Licença ativa. Próxima renovação / validade até ${ate}.`;if(empresa.status==='bloqueado')return'Acesso encerrado. Renove a assinatura para continuar.';return null;}
export{empresaTemAcesso,enforcarExpiracoes};
export function mountStripeRoutes(app:Express,getDb:()=>Database){
app.post(
    '/api/webhook/stripe',
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      const db = getDb();
      let eventType = 'unknown';
      let stripeEventId = '';
      try {
        const sig = req.headers['stripe-signature'] as string | undefined;
        const raw = req.body as Buffer;
        const event = constructStripeEvent(raw, sig);
        await ensureStripeColumns(db);
        await enforcarExpiracoes(db);

        const type = String(event.type || '');
        eventType = type;
        const eventId = String(event.id || '').trim();
        if (!eventId) {
          throw new Error('Evento Stripe sem id');
        }
        stripeEventId = eventId;
        const claim = await claimWebhookEvent({
          source: 'stripe',
          eventId,
          eventType: type,
        }, db);
        if (!claim.isNew) {
          return res.json({ ok: true, action: 'duplicate_event' });
        }
        const obj = event.data?.object || {};

        const done = async (action: string, status: 'ok' | 'ignored' = 'ok') => {
          await updateWebhookAction('stripe', eventId, action, db);
          await logWebhookEvent(db, {
            source: 'stripe',
            event_type: type,
            status,
            detail: action,
            payload_summary: JSON.stringify({
              id: event.id || null,
              object: obj?.object || null,
              customer: obj?.customer || null,
              status: obj?.status || null,
            }).slice(0, 400),
          });
          return res.json({ ok: true, action });
        };

        if (type === 'customer.subscription.updated') {
          let { empresaId, planDb, customerId, subscriptionId } = extractFromStripeObject(obj);
          empresaId = await resolveEmpresaId(db, empresaId, customerId);
          const periodEnd = periodEndFromStripe(obj);
          const stripeStatus = String(obj.status || '');

          if (obj.cancel_at_period_end === true && empresaId) {
            await markCancelAtPeriodEnd(db, empresaId, periodEnd);
            return done('cancel_at_period_end');
          }
          if (stripeStatus === 'canceled' && empresaId) {
            if (periodEnd && new Date(periodEnd).getTime() > Date.now()) {
              await markCancelAtPeriodEnd(db, empresaId, periodEnd);
              return done('grace_until_period_end');
            }
            await blockEmpresa(db, empresaId);
            return done('block');
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
            if (type === 'invoice.paid' || type === 'checkout.session.completed') {
              const rawAmount = Number(obj.amount_paid ?? obj.amount_total ?? 0);
              await createFiscalDocumentForPayment(db, empresaId, eventId, rawAmount / 100);
            }
            return done('activate');
          }
        }

        if (
          type === 'checkout.session.completed' ||
          type === 'customer.subscription.created' ||
          type === 'invoice.paid'
        ) {
          let { empresaId, planDb, customerId, subscriptionId } = extractFromStripeObject(obj);
          empresaId = await resolveEmpresaId(db, empresaId, customerId);
          const periodEnd = periodEndFromStripe(obj);

          if (
            type === 'checkout.session.completed' &&
            obj.payment_status &&
            obj.payment_status !== 'paid' &&
            obj.payment_status !== 'no_payment_required'
          ) {
            return done('pending', 'ignored');
          }

          if (empresaId && (planDb || type === 'invoice.paid')) {
            const resolved = resolvePlano(planDb || 'pro');
            await activatePlan(
              db,
              empresaId,
              resolved?.planDb || planDb || 'pro',
              customerId,