import type { Express } from 'express';
import { Router } from 'express';
import { enqueueRetry } from '../lib/retryQueue.js';

function tokenFrom(req: any): string {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-n8n-email-token'] || '').trim();
}

export function mountN8nEmailRoutes(app: Express) {
  const router = Router();

  router.post('/email', async (req, res) => {
    const expected = String(process.env.N8N_EMAIL_TOKEN || '').trim();
    if (!expected || tokenFrom(req) !== expected) {
      return res.status(401).json({ ok: false, error: 'não autorizado' });
    }

    const body = req.body || {};
    const to = String(body.to || '').trim();
    const subject = String(body.subject || '').trim();
    const text = String(body.text || body.message || '').trim();
    const html = body.html ? String(body.html) : undefined;
    const idempotencyKey = String(body.idempotency_key || '').trim();

    if (!to || !subject || !text) {
      return res.status(400).json({ ok: false, error: 'to, subject e text são obrigatórios' });
    }

    try {
      const id = await enqueueRetry({
        jobType: 'email',
        payload: { to, subject, text, ...(html ? { html } : {}) },
        dedupeKey: idempotencyKey ? `n8n-email:${idempotencyKey}` : null,
      });

      return res.status(202).json({ ok: true, queued: true, job_id: id });
    } catch (error: any) {
      console.error('[n8n email]', error?.message || error);
      return res.status(500).json({ ok: false, error: 'falha ao enfileirar e-mail' });
    }
  });

  app.use('/api/internal/n8n', router);
}
