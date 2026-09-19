/**
 * Follow-ups comerciais — revisão humana e execução controlada.
 */
import type { Express, Response } from 'express';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getDb } from '../lib/db.js';
import { enqueueRetry } from '../lib/retryQueue.js';

export async function ensureFollowupSchema(db: any = getDb()) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS lead_followups (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'email',
      draft TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      approval_required INTEGER NOT NULL DEFAULT 1,
      approved_by TEXT,
      approved_at TIMESTAMPTZ,
      rejected_by TEXT,
      rejected_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      message_id TEXT,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_lead_followups_status ON lead_followups(status)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_lead_followups_lead ON lead_followups(lead_id)`);
}

function requireAdmin(req: AuthRequest, res: Response): boolean {
  if (!isAdminUser(req.user)) {
    res.status(403).json({ error: 'Acesso negado.' });
    return false;
  }
  return true;
}

export function mountAdminFollowupRoutes(app: Express) {
  app.get('/api/admin/followups', autenticarToken, asyncHandler(async (req: AuthRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const db = getDb();
    await ensureFollowupSchema(db);
    const status = String(req.query.status || 'pending').trim();
    const allowed = ['pending', 'approved', 'rejected', 'sending', 'sent', 'failed'];
    const where = allowed.includes(status) ? 'WHERE f.status = ?' : '';
    const params = where ? [status] : [];
    const rows = await db.all(`
      SELECT f.*, l.nome_empresa, l.email, l.telefone, l.score, l.qualification, l.ai_reason
      FROM lead_followups f
      LEFT JOIN leads l ON l.id = f.lead_id
      ${where}
      ORDER BY f.created_at DESC
      LIMIT 100
    `, params);
    res.json(rows || []);
  }));

  app.post('/api/admin/followups/:id/approve', autenticarToken, asyncHandler(async (req: AuthRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const db = getDb();
    await ensureFollowupSchema(db);
    const id = String(req.params.id);
    const followup = await db.get(`
      SELECT f.*, l.email, l.nome_empresa
      FROM lead_followups f
      LEFT JOIN leads l ON l.id = f.lead_id
      WHERE f.id = ?
    `, [id]);
    if (!followup) return res.status(404).json({ error: 'Follow-up não encontrado.' });
    if (followup.status !== 'pending' || Number(followup.approval_required) !== 1) {
      return res.status(409).json({ error: `Follow-up não está pendente: ${followup.status}.` });
    }
    if (String(followup.channel) !== 'email') {
      return res.status(400).json({ error: 'Canal ainda não suportado para execução automática.' });
    }
    const email = String(followup.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Lead sem e-mail válido.' });
    }

    const draft = String(req.body?.draft || followup.draft || '').trim();
    if (!draft) return res.status(400).json({ error: 'Rascunho vazio.' });
    const now = new Date().toISOString();
    await db.run(`
      UPDATE lead_followups
      SET draft = ?, status = 'approved', approval_required = 0, approved_by = ?, approved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND approval_required = 1
    `, [draft.slice(0, 10000), req.user?.id || 'admin', now, now, id]);

    const check = await db.get(`SELECT status FROM lead_followups WHERE id = ?`, [id]);
    if (check?.status !== 'approved') {
      return res.status(409).json({ error: 'Follow-up já foi processado.' });
    }

    const jobId = await enqueueRetry({
      jobType: 'followup_email',
      payload: { followup_id: id },
      dedupeKey: `followup_email:${id}`,
    }, db);

    res.json({ success: true, followup_id: id, status: 'approved', job_id: jobId });
  }));

  app.post('/api/admin/followups/:id/reject', autenticarToken, asyncHandler(async (req: AuthRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const db = getDb();
    await ensureFollowupSchema(db);
    const id = String(req.params.id);
    const row = await db.get(`SELECT status FROM lead_followups WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: 'Follow-up não encontrado.' });
    if (row.status !== 'pending') return res.status(409).json({ error: `Follow-up não está pendente: ${row.status}.` });
    const now = new Date().toISOString();
    await db.run(`
      UPDATE lead_followups
      SET status = 'rejected', approval_required = 0, rejected_by = ?, rejected_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `, [req.user?.id || 'admin', now, now, id]);
    res.json({ success: true, followup_id: id, status: 'rejected' });
  }));
}
