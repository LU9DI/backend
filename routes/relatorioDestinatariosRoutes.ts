import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import { getDb, findEmpresa } from '../lib/db.js';
import { autenticarToken, isAdminUser, type AuthRequest } from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { planoTemRelatorioWhatsApp } from '../lib/plans.js';
import { normalizarWhatsapp } from '../lib/whatsapp.js';
import { ensureRuntimeSchema } from '../lib/schemaEnsure.js';

const CANAIS = ['whatsapp', 'sms', 'wechat', 'email'] as const;
type Canal = (typeof CANAIS)[number];
const MAX_DESTINATARIOS = 20;

function podeGerirEmpresa(req: AuthRequest, empresaId: string): boolean {
  if (isAdminUser(req.user)) return true;
  return Boolean(req.user?.empresa_id && req.user.empresa_id === empresaId);
}

function normalizarDestino(canal: Canal, raw: unknown): string | null {
  const value = String(raw || '').trim();
  if (!value) return null;

  if (canal === 'whatsapp' || canal === 'sms') {
    const numero = normalizarWhatsapp(value);
    if (!numero) return null;
    return numero;
  }

  if (canal === 'email') {
    const email = value.toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return email;
  }

  // WeChat: aceita o identificador do destinatário; não confundir com WeChat Pay.
  if (value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function validarCanal(value: unknown): value is Canal {
  return CANAIS.includes(String(value || '').toLowerCase() as Canal);
}

export function mountRelatorioDestinatariosRoutes(app: Express) {
  app.get(
    '/api/empresa/:ref/relatorio-destinatarios',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerirEmpresa(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });
      if (!planoTemRelatorioWhatsApp(empresa.plan)) {
        return res.status(403).json({ error: 'O relatório mensal não está disponível no plano Inicial.', code: 'REPORT_NOT_AVAILABLE' });
      }

      const db = getDb();
      await ensureRuntimeSchema(db);
      const rows = await db.all(
        `SELECT id, canal, destino, nome, ativo, criado_em
         FROM relatorio_destinatarios
         WHERE empresa_id = ? AND ativo = 1
         ORDER BY criado_em ASC`,
        [empresa.id]
      );

      return res.json({
        success: true,
        canais: CANAIS,
        destinatarios: rows || [],
        limite: MAX_DESTINATARIOS,
      });
    })
  );

  app.post(
    '/api/empresa/:ref/relatorio-destinatarios',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerirEmpresa(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });
      if (!planoTemRelatorioWhatsApp(empresa.plan)) {
        return res.status(403).json({ error: 'O relatório mensal não está disponível no plano Inicial.', code: 'REPORT_NOT_AVAILABLE' });
      }

      const canal = String(req.body.canal || '').toLowerCase();
      if (!validarCanal(canal)) {
        return res.status(400).json({ error: 'Canal inválido. Use: whatsapp, sms, wechat ou email.' });
      }
      const destino = normalizarDestino(canal, req.body.destino);
      if (!destino) {
        return res.status(400).json({ error: `Destino inválido para ${canal}.` });
      }
      const nome = String(req.body.nome || '').trim().slice(0, 100) || null;

      const db = getDb();
      await ensureRuntimeSchema(db);
      const count = await db.get(
        `SELECT COUNT(*) AS total FROM relatorio_destinatarios WHERE empresa_id = ? AND ativo = 1`,
        [empresa.id]
      );
      if (Number(count?.total || 0) >= MAX_DESTINATARIOS) {
        return res.status(409).json({ error: `Limite de ${MAX_DESTINATARIOS} destinatários atingido.`, code: 'RECIPIENT_LIMIT' });
      }

      const existente = await db.get(
        `SELECT id, ativo FROM relatorio_destinatarios WHERE empresa_id = ? AND canal = ? AND destino = ?`,
        [empresa.id, canal, destino]
      );
      if (existente?.ativo) {
        return res.status(409).json({ error: 'Este destinatário já está cadastrado.', code: 'RECIPIENT_EXISTS' });
      }

      const id = String(existente?.id || crypto.randomUUID());
      if (existente) {
        await db.run(
          `UPDATE relatorio_destinatarios SET nome = ?, ativo = 1 WHERE id = ?`,
          [nome, id]
        );
      } else {
        await db.run(
          `INSERT INTO relatorio_destinatarios (id, empresa_id, canal, destino, nome, ativo) VALUES (?, ?, ?, ?, ?, 1)`,
          [id, empresa.id, canal, destino, nome]
        );
      }

      const row = await db.get(
        `SELECT id, canal, destino, nome, ativo, criado_em FROM relatorio_destinatarios WHERE id = ?`,
        [id]
      );
      return res.status(201).json({ success: true, destinatario: row });
    })
  );

  app.delete(
    '/api/empresa/:ref/relatorio-destinatarios/:id',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const empresa = await findEmpresa(req.params.ref);
      if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
      if (!podeGerirEmpresa(req, empresa.id)) return res.status(403).json({ error: 'Sem permissão.' });

      const db = getDb();
      await ensureRuntimeSchema(db);
      const result = await db.run(
        `UPDATE relatorio_destinatarios SET ativo = 0 WHERE id = ? AND empresa_id = ? AND ativo = 1`,
        [req.params.id, empresa.id]
      );
      if (Number(result.changes || 0) !== 1) {
        return res.status(404).json({ error: 'Destinatário não encontrado.' });
      }
      return res.json({ success: true });
    })
  );
}
