/**
 * Ativação / bloqueio de planos (regra de negócio).
 *
 * Aniversário do relatório (report_next_due_at):
 * - Definido na PRIMEIRA ativação (ou reativação após bloqueio/trial).
 * - NÃO é recalculado em webhook/retry da mesma assinatura.
 * - NÃO é recalculado em renovação enquanto a empresa já está ativa com due setado.
 * - Só recalcula com forceNewReportCycle=true ou se ainda não existir due.
 */
import type { Database } from 'sqlite';
import { resolvePlano } from '../stripeBilling.js';
import {
  notificarPagamentoConfirmado,
  notificarCancelamentoAgendado,
  notificarAcessoExpirado,
} from '../lib/notifications.js';

const REPORT_TIME_ZONE = 'America/Sao_Paulo';

function normalizePlanDb(planDb: string): string {
  const p = String(planDb || '').toLowerCase();
  if (p === 'corporativo' || p === 'corporate') return 'corporativo';
  if (p === 'rei' || p === 'rei-anual') return 'rei';
  if (p === 'ultra' || p === 'ultra-anual') return 'ultra';
  if (p === 'inicial' || p === 'inicial-anual') return 'inicial';
  if (p === 'pro' || p === 'pro-anual') return 'pro';
  const resolved = resolvePlano(p);
  return resolved?.planDb || 'pro';
}

/**
 * Próximo aniversário no fuso America/Sao_Paulo.
 * Persistido em ISO/UTC; o “dia do mês” é o do Brasil.
 * Meses curtos: min(dia, último dia do mês).
 */
export function proximoRelatorioMensal(from: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(from);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');

  // month 1–12; próximo mês no calendário civil BR
  const nextMonthIndex = month; // Date.UTC month 0-based = calendar month number for “next”
  const lastDay = new Date(Date.UTC(year, nextMonthIndex + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);

  // São Paulo fixo UTC−3 (sem DST atualmente)
  const targetUtc = Date.UTC(year, nextMonthIndex, targetDay, hour, minute, second);
  return new Date(targetUtc + 3 * 60 * 60 * 1000).toISOString();
}

function sameId(a: unknown, b: unknown): boolean {
  if (a == null || b == null || a === '' || b === '') return false;
  return String(a) === String(b);
}

async function emailDaEmpresa(db: Database, empresaId: string): Promise<string | null> {
  const user = await db.get(
    'SELECT email FROM usuarios WHERE empresa_id = ? AND email IS NOT NULL LIMIT 1',
    [empresaId]
  );
  return user?.email || null;
}

export type ActivatePlanOpts = {
  /**
   * Força novo ciclo de relatório (novo aniversário a partir de agora).
   * Use só em nova assinatura real / reativação após longo bloqueio, nunca em retry de webhook.
   */
  forceNewReportCycle?: boolean;
  /** Se true, não envia e-mail/notificação (útil em retries internos). */
  silent?: boolean;
};

/**
 * Decide se devemos preservar report_next_due_at existente.
 *
 * PRESERVA quando:
 * - Já existe report_next_due_at E a empresa está ativa (renovação / webhook repetido / upgrade de plano)
 * - Ou o subscription_id recebido é o mesmo já gravado (retry Stripe/MP)
 *
 * RECALCULA quando:
 * - forceNewReportCycle
 * - Ainda não tem report_next_due_at
 * - Empresa não está ativa (trial / bloqueado) → primeira ativação “de verdade” do ciclo pago
 */
function shouldPreserveReportAnniversary(opts: {
  forceNewReportCycle?: boolean;
  status?: string | null;
  reportNextDueAt?: string | null;
  existingSubId?: string | null;
  incomingSubId?: string | null;
}): boolean {
  if (opts.forceNewReportCycle) return false;
  if (!opts.reportNextDueAt) return false;

  const status = String(opts.status || '').toLowerCase();
  const activeLike = status === 'ativo' || status === 'active';

  // Mesma assinatura = retry / invoice.paid repetido
  if (sameId(opts.existingSubId, opts.incomingSubId)) return true;

  // Já ativa com aniversário definido = renovação ou upgrade sem mudar o ciclo
  if (activeLike) return true;

  return false;
}

export async function activatePlan(
  db: Database,
  empresaId: string,
  planDb: string,
  customerId?: string | null,
  subscriptionId?: string | null,
  periodEndIso?: string | null,
  opts?: ActivatePlanOpts
) {
  const normalized = normalizePlanDb(planDb);
  const agora = new Date();
  const expira =
    periodEndIso || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const existing = await db.get(
    `SELECT id, status, plan, report_next_due_at, report_last_sent_at,
            stripe_subscription_id, stripe_customer_id
     FROM empresas WHERE id = ?`,
    [empresaId]
  );

  const preserve = shouldPreserveReportAnniversary({
    forceNewReportCycle: opts?.forceNewReportCycle,
    status: existing?.status,
    reportNextDueAt: existing?.report_next_due_at,
    existingSubId: existing?.stripe_subscription_id,
    incomingSubId: subscriptionId,
  });

  const reportNextDue = preserve
    ? String(existing.report_next_due_at)
    : proximoRelatorioMensal(agora);

  // report_last_sent_at: só zera em ciclo NOVO (não em retry)
  if (preserve) {
    await db.run(
      `UPDATE empresas
       SET status = 'ativo',
           plan = ?,
           expira_em = ?,
           cancel_at_period_end = 0,
           report_next_due_at = ?
       WHERE id = ?`,
      [normalized, expira, reportNextDue, empresaId]
    );
  } else {
    await db.run(
      `UPDATE empresas
       SET status = 'ativo',
           plan = ?,
           expira_em = ?,
           cancel_at_period_end = 0,
           report_next_due_at = ?,
           report_last_sent_at = NULL
       WHERE id = ?`,
      [normalized, expira, reportNextDue, empresaId]
    );
  }

  if (customerId) {
    await db.run(`UPDATE empresas SET stripe_customer_id = ? WHERE id = ?`, [
      customerId,
      empresaId,
    ]);
  }
  if (subscriptionId) {
    await db.run(`UPDATE empresas SET stripe_subscription_id = ? WHERE id = ?`, [
      subscriptionId,
      empresaId,
    ]);
  }

  if (!opts?.silent) {
    try {
      const emp = await db.get('SELECT nome_empresa, slug FROM empresas WHERE id = ?', [
        empresaId,
      ]);
      const email = await emailDaEmpresa(db, empresaId);
      if (email) {
        await notificarPagamentoConfirmado({
          email,
          nomeEmpresa: emp?.nome_empresa || 'Empresa',
          plano: normalized,
          expiraEm: expira,
          slug: emp?.slug,
          empresaId,
        });
      }
    } catch (e: any) {
      console.warn('[billing] e-mail ativação falhou:', e?.message || e);
    }
  }

  console.log(
    `[billing] plano ativado empresa=${empresaId} plan=${normalized} report_due=${reportNextDue} anniversary=${preserve ? 'preserved' : 'reset'}`
  );

  return {
    plan: normalized,
    expira_em: expira,
    report_next_due_at: reportNextDue,
    anniversary_preserved: preserve,
  };
}

export async function markCancelAtPeriodEnd(
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
    await db.run(`UPDATE empresas SET cancel_at_period_end = 1, status = 'ativo' WHERE id = ?`, [
      empresaId,
    ]);
  }

  try {
    const emp = await db.get(
      'SELECT nome_empresa, slug, plan, expira_em FROM empresas WHERE id = ?',
      [empresaId]
    );
    const email = await emailDaEmpresa(db, empresaId);
    if (email) {
      await notificarCancelamentoAgendado({
        email,
        nomeEmpresa: emp?.nome_empresa || 'Empresa',
        plano: emp?.plan,
        expiraEm: periodEndIso || emp?.expira_em || null,
        slug: emp?.slug,
        empresaId,
      });
    }
  } catch (e: any) {
    console.warn('[billing] e-mail cancelamento falhou:', e?.message || e);
  }

  console.log(`[billing] cancel_at_period_end empresa=${empresaId}`);
}

export async function blockEmpresa(
  db: Database,
  empresaId: string,
  opts?: { notify?: boolean; tipo?: 'trial' | 'assinatura' | 'cancelamento' }
) {
  const empBefore = await db.get(
    'SELECT nome_empresa, slug, plan, status, expira_em, cancel_at_period_end FROM empresas WHERE id = ?',
    [empresaId]
  );

  await db.run(
    `UPDATE empresas SET status = 'bloqueado', cancel_at_period_end = 0 WHERE id = ?`,
    [empresaId]
  );

  if (opts?.notify !== false) {
    try {
      const email = await emailDaEmpresa(db, empresaId);
      if (email && empBefore) {
        const tipo =
          opts?.tipo ||
          (empBefore.status === 'trial'
            ? 'trial'
            : Number(empBefore.cancel_at_period_end) === 1
              ? 'cancelamento'
              : 'assinatura');
        await notificarAcessoExpirado({
          email,
          nomeEmpresa: empBefore.nome_empresa || 'Empresa',
          tipo,
          plano: empBefore.plan,
          expiraEm: empBefore.expira_em,
          slug: empBefore.slug,
          empresaId,
        });
      }
    } catch (e: any) {
      console.warn('[billing] e-mail bloqueio falhou:', e?.message || e);
    }
  }

  console.log(`[billing] bloqueado empresa=${empresaId}`);
}

export function empresaTemAcesso(empresa: {
  status?: string;
  expira_em?: string | null;
}): boolean {
  const status = String(empresa?.status || '');
  const agora = Date.now();
  const fim = empresa?.expira_em ? new Date(empresa.expira_em).getTime() : null;
  if (status === 'ativo' || status === 'trial') {
    if (fim == null || Number.isNaN(fim)) return true;
    return agora <= fim;
  }
  return false;
}

export async function enforcarExpiracoes(db: Database) {
  const agora = new Date().toISOString();
  await db.run(
    `UPDATE empresas
    SET status = 'bloqueado', cancel_at_period_end = 0
    WHERE status = 'ativo'
      AND cancel_at_period_end = 1
      AND expira_em IS NOT NULL
      AND expira_em < ?`,
    [agora]
  );
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
