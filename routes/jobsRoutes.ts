/**
 * Jobs internos (cron / Railway / GitHub Actions).
 * Protegido por JOBS_SECRET no header Authorization: Bearer <secret>
 * ou query ?secret=
 */
import type { Express, Request, Response } from 'express';
import { getDb } from '../lib/db.js';
import { notificarTrialExpirando, smtpConfigured } from '../lib/notifications.js';
import { enforcarExpiracoes } from '../services/billingService.js';

function authorized(req: Request): boolean {
  const secret = process.env.JOBS_SECRET?.trim();
  if (!secret) {
    // Em dev sem secret, libera só se NODE_ENV !== production
    return process.env.NODE_ENV !== 'production';
  }
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const q = String(req.query.secret || '');
  return bearer === secret || q === secret;
}

export function mountJobsRoutes(app: Express) {
  /**
   * POST /api/jobs/trial-expiring
   * Envia e-mail para trials que expiram em 1 ou 2 dias (uma vez por “janela”).
   */
  app.post('/api/jobs/trial-expiring', async (req: Request, res: Response) => {
    if (!authorized(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const db = getDb();
      await enforcarExpiracoes(db);

      // Garante coluna de controle de envio
      const cols = (await db.all(`PRAGMA table_info(empresas)`)).map((c: any) => c.name);
      if (!cols.includes('trial_remind_sent_at')) {
        await db.exec(`ALTER TABLE empresas ADD COLUMN trial_remind_sent_at TEXT`);
      }

      const agora = Date.now();
      const in2d = new Date(agora + 2 * 24 * 60 * 60 * 1000).toISOString();
      const agoraIso = new Date(agora).toISOString();

      const rows = await db.all(
        `SELECT e.id, e.nome_empresa, e.slug, e.expira_em, e.trial_remind_sent_at,
                u.email
         FROM empresas e
         LEFT JOIN usuarios u ON u.empresa_id = e.id AND u.email IS NOT NULL
         WHERE e.status = 'trial'
           AND e.expira_em IS NOT NULL
           AND e.expira_em > ?
           AND e.expira_em <= ?
         GROUP BY e.id`,
        [agoraIso, in2d]
      );

      let enviados = 0;
      let pulados = 0;

      for (const e of rows || []) {
        if (!e.email) {
          pulados++;
          continue;
        }
        // Evita reenvio na mesma janela de 24h
        if (e.trial_remind_sent_at) {
          const last = new Date(e.trial_remind_sent_at).getTime();
          if (agora - last < 20 * 60 * 60 * 1000) {
            pulados++;
            continue;
          }
        }

        const dias = Math.max(
          0,
          Math.ceil((new Date(e.expira_em).getTime() - agora) / 86400000)
        );

        const ok = await notificarTrialExpirando({
          email: e.email,
          nomeEmpresa: e.nome_empresa,
          expiraEm: e.expira_em,
          dias,
          slug: e.slug,
          empresaId: e.id,
        });

        if (ok.ok) {
          await db.run(`UPDATE empresas SET trial_remind_sent_at = ? WHERE id = ?`, [
            new Date().toISOString(),
            e.id,
          ]);
          enviados++;
        } else {
          pulados++;
        }
      }

      res.json({
        success: true,
        enviados,
        pulados,
        candidatos: (rows || []).length,
        smtp: smtpConfigured(),
      });
    } catch (e: any) {
      console.error('jobs/trial-expiring:', e?.message || e);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  });
}
