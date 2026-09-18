import type { Express, Request, Response } from 'express';
import { getDb } from '../lib/db.js';
import {
  ensureFiscalSchema,
  fiscalConfigured,
  listFiscalDocuments,
  upsertFiscalRecipient,
  processFiscalDocument,
  syncFiscalDocument,
} from '../lib/fiscal.js';
import { autenticarToken, empresaInformadaPertenceAoToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { findEmpresa } from '../lib/empresa.js';

function canManage(req: AuthRequest, empresaId: string): boolean {
  return isAdminUser(req.user) || empresaInformadaPertenceAoToken(req, empresaId);
}

export function mountFiscalRoutes(app: Express) {
  app.get('/api/fiscal/status', autenticarToken, (_req, res) => {
    res.json({
      configured: fiscalConfigured(),
      provider: 'focus_nfe',
      environment: process.env.FOCUS_NFE_ENV === 'producao' ? 'producao' : 'homologacao',
    });
  });

  app.get('/api/empresa/:ref/fiscal', autenticarToken, async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(String(req.params.ref));
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!canManage(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });
    const db = getDb();
    await ensureFiscalSchema(db);
    const items = await listFiscalDocuments(db, empresa.id);
    res.json({ configured: fiscalConfigured(), items });
  });

  app.put('/api/empresa/:ref/fiscal/recipient', autenticarToken, async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(String(req.params.ref));
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!canManage(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });

    const body = req.body || {};
    const cpf = String(body.cpf || '').replace(/\D/g, '');
    const cnpj = String(body.cnpj || '').replace(/\D/g, '');
    if ((cpf && cnpj) || (!cpf && !cnpj)) {
      return res.status(400).json({ error: 'Informe CPF ou CNPJ do tomador, não ambos.' });
    }

    const db = getDb();
    await ensureFiscalSchema(db);
    const profile = await upsertFiscalRecipient(db, empresa.id, {
      nome: body.nome,
      cpf,
      cnpj,
      email: body.email,
      codigo_municipio: body.codigo_municipio,
    });
    res.json({ ok: true, profile });
  });

  app.post('/api/empresa/:ref/fiscal/process/:id', autenticarToken, async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(String(req.params.ref));
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!canManage(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });

    const db = getDb();
    await ensureFiscalSchema(db);
    const doc = await db.get('SELECT id, empresa_id FROM fiscal_documents WHERE id = ?', [String(req.params.id)]);
    if (!doc || String(doc.empresa_id) !== String(empresa.id)) {
      return res.status(404).json({ error: 'Documento fiscal não encontrado.' });
    }

    await processFiscalDocument(db, doc.id);
    res.json({ ok: true });
  });

  app.post('/api/empresa/:ref/fiscal/sync/:reference', autenticarToken, async (req: AuthRequest, res: Response) => {
    const empresa = await findEmpresa(String(req.params.ref));
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    if (!canManage(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });

    const db = getDb();
    await ensureFiscalSchema(db);
    const doc = await db.get(
      'SELECT id, empresa_id FROM fiscal_documents WHERE provider_ref = ?',
      [String(req.params.reference)]
    );
    if (!doc || String(doc.empresa_id) !== String(empresa.id)) {
      return res.status(404).json({ error: 'Documento fiscal não encontrado.' });
    }

    await syncFiscalDocument(db, String(req.params.reference));
    res.json({ ok: true });
  });

  app.post('/api/webhook/fiscal/focus', async (req: Request, res: Response) => {
    const expected = String(process.env.FISCAL_WEBHOOK_TOKEN || '').trim();
    const received = String(req.headers['x-fiscal-token'] || '').trim();
    if (!expected || received !== expected) {
      return res.status(401).json({ error: 'Webhook fiscal não autorizado.' });
    }

    const body = req.body || {};
    const reference = String(body.ref || body.referencia || '').trim();
    if (!reference) return res.status(400).json({ error: 'Referência fiscal ausente.' });

    const db = getDb();
    await ensureFiscalSchema(db);
    const doc = await db.get(
      'SELECT id FROM fiscal_documents WHERE provider = ? AND provider_ref = ?',
      ['focus_nfe', reference]
    );
    if (!doc) return res.status(404).json({ error: 'Documento fiscal não encontrado.' });

    await syncFiscalDocument(db, reference);
    res.json({ ok: true });
  });
}
