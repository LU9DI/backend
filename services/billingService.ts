/**
 * Ativação / bloqueio de planos via Stripe (regra de negócio).
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
 * Calcula o próximo aniversário usando a data/hora local do Brasil.
 * A data persistida continua em ISO/UTC, mas o dia do mês é definido em
 * America/Sao_Paulo. Assim, uma ativação em 12/09 no Brasil vence o relatório
 * em 12/10 no Brasil, independentemente do fuso do servidor Render.
 *
 * O cálculo usa Intl em vez de dependências externas de timezone.
 */
function proximoRelatorioMensal(from: Date): string {
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
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');

  const nextMonthIndex = month; // month 1-12; Date.UTC expects 0-based month.
  const lastDay = new Date(Date.UTC(year, nextMonthIndex + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDay);

  // Brasil não observa horário de verão atualmente. O offset de São Paulo é
  // -03:00, portanto a data local alvo pode ser persistida diretamente como UTC+03.
  const targetUtc = Date.UTC(year, nextMonthIndex, targetDay, hour, minute, second);
  return new Date(targetUtc + 3 * 60 * 60 * 1000).toISOString();
}

async function emailDaEmpresa(db: Database, empresaId: string): Promise<string | null> {
  const user = await db.get(
    'SELECT email FROM usuarios WHERE empresa_id = ? AND email IS NOT NULL LIMIT 1',
    [empresaId]
  );
  return user?.email || null;
}

export async function activatePlan(
  db: Database,
  empresaId: string,
  planDb: string,
  customerId?: string | null,
  subscriptionId?: string | null,
  periodEndIso?: string | null
) {
  const normalized = normalizePlanDb(planDb);
  const agora = new Date();
  const expira =
    periodEndIso || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const reportNextDue = proximoRelatorioMensal(agora);

  await db.run(
    `UPDATE empresas SET status = 'ativo', plan = ?, expira_em = ?, cancel_at_period_end = 0,
       report_next_due_at = ?, report_last_sent_at = NULL WHERE id = ?`,
    [normalized, expira, reportNextDue, empresaId]
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

  try {
    const emp = await db.get('SELECT nome_empresa, slug FROM empresas WHERE id = ?', [empresaId]);
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

  console.log(`[billing] plano ativado empresa=${empresaId} plan=${normalized}`);
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
