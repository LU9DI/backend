/**
 * Ativação / bloqueio de planos + n8n.
 */
import type { Database } from 'sqlite';
import { resolvePlano } from '../stripeBilling.js';
import {
  notificarPagamentoConfirmado,
  notificarCancelamentoAgendado,
  notificarAcessoExpirado,
} from '../lib/notifications.js';
import { notifyN8n } from '../lib/n8n.js';

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
  const now = new Date();
  const expira =
    periodEndIso || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Guarda o dia original da assinatura para a cadência mensal individual.
  // O COALESCE preserva o aniversário nas renovações subsequentes.
  try {
    await db.exec('ALTER TABLE empresas ADD COLUMN IF NOT EXISTS relatorio_dia_assinatura INTEGER');
  } catch {
    try {
      const cols = (await db.all('PRAGMA table_info(empresas)')).map((c: any) => c.name);
      if (!cols.includes('relatorio_dia_assinatura')) {
        await db.exec('ALTER TABLE empresas ADD COLUMN relatorio_dia_assinatura INTEGER');
      }
    } catch { /* a gravação abaixo reportará a falha se o schema não estiver disponível */ }
  }
  await db.run(
    `UPDATE empresas SET status = 'ativo', plan = ?, expira_em = ?, cancel_at_period_end = 0,
       relatorio_dia_assinatura = COALESCE(relatorio_dia_assinatura, ?)
     WHERE id = ?`,
    [normalized, expira, now.getUTCDate(), empresaId]
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
    const emp = await db.get('SELECT nome_empresa, slug, cnpj FROM empresas WHERE id = ?', [
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
    notifyN8n('payment.confirmado', {
      empresa_id: empresaId,
      slug: emp?.slug,
      cnpj: emp?.cnpj,
      nome_empresa: emp?.nome_empresa,
      email,
      plano: normalized,
      expira_em: expira,
      customer_id: customerId || null,
      subscription_id: subscriptionId || null,
    });
  } catch (e: any) {
    console.warn('[billing] pós-ativação:', e?.message || e);
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
      'SELECT nome_empresa, slug, plan, expira_em, cnpj FROM empresas WHERE id = ?',
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
    notifyN8n('payment.cancelado', {
      empresa_id: empresaId,
      slug: emp?.slug,
      cnpj: emp?.cnpj,
      nome_empresa: emp?.nome_empresa,
      email,
      plano: emp?.plan,
      expira_em: periodEndIso || emp?.expira_em,
    });
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
    'SELECT nome_empresa, slug, plan, status, expira_em, cancel_at_period_end, cnpj FROM empresas WHERE id = ?',
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
        notifyN8n('empresa.bloqueada', {
          empresa_id: empresaId,
          slug: empBefore.slug,
          cnpj: empBefore.cnpj,
          nome_empresa: empBefore.nome_empresa,
          email,
          plano: empBefore.plan,
          tipo,
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
