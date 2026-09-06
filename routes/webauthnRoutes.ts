/**
 * Rotas WebAuthn (digital / passkey).
 */
import type { Express, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../lib/db.js';
import {
  autenticarToken,
  setAuthCookie,
  signAccessToken,
  type AuthRequest,
} from '../lib/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import {
  ensureWebAuthnSchema,
  registrationOptions,
  finishRegistration,
  authenticationOptions,
  finishAuthentication,
  listCredentials,
  deleteCredential,
  webauthnConfig,
} from '../lib/webauthn.js';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: { error: 'Muitas tentativas de biometria. Aguarde.' },
});

async function handleRegisterVerify(req: AuthRequest, res: Response) {
  const db = getDb();
  await ensureWebAuthnSchema(db);
  if (!req.user?.id) return res.status(401).json({ error: 'Não autenticado.' });

  const {
    challengeId,
    credentialId,
    publicKey,
    clientDataJSON,
    deviceName,
    transports,
  } = req.body || {};

  try {
    const result = await finishRegistration(db, {
      challengeId: String(challengeId),
      userId: req.user.id,
      credentialId: String(credentialId),
      publicKey: String(publicKey),
      clientDataJSON: String(clientDataJSON),
      deviceName: deviceName ? String(deviceName) : undefined,
      transports: Array.isArray(transports) ? transports.map(String) : undefined,
    });
    res.json({ success: true, ...result });
  } catch (e: any) {
    res.status(400).json({ error: e.message || 'Falha ao registrar digital.' });
  }
}

export function mountWebAuthnRoutes(app: Express) {
  app.get('/api/webauthn/config', (_req, res) => {
    res.json({ ...webauthnConfig(), available: true });
  });

  app.post(
    '/api/webauthn/register/options',
    limiter,
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const db = getDb();
      await ensureWebAuthnSchema(db);
      if (!req.user?.id) return res.status(401).json({ error: 'Não autenticado.' });

      const user = await db.get('SELECT * FROM usuarios WHERE id = ?', [req.user.id]);
      if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

      try {
        const opts = await registrationOptions(db, {
          id: user.id,
          nome: user.nome_funcionario,
          cnpj: user.cnpj,
        });
        res.json(opts);
      } catch (e: any) {
        res.status(400).json({ error: e.message || 'Falha ao iniciar registro.' });
      }
    })
  );

  // Alias: /verify (oficial) e /finish (frontend legado)
  app.post(
    '/api/webauthn/register/verify',
    limiter,
    autenticarToken,
    asyncHandler(handleRegisterVerify)
  );
  app.post(
    '/api/webauthn/register/finish',
    limiter,
    autenticarToken,
    asyncHandler(handleRegisterVerify)
  );

  app.post(
    '/api/webauthn/login/options',
    limiter,
    asyncHandler(async (req, res) => {
      const db = getDb();
      await ensureWebAuthnSchema(db);
      const cnpj = String(req.body?.cnpj || '').replace(/\D/g, '');
      if (cnpj.length < 11) {
        return res.status(400).json({ error: 'Informe o CNPJ para usar a digital.' });
      }
      try {
        const opts = await authenticationOptions(db, cnpj);
        res.json(opts);
      } catch (e: any) {
        res.status(400).json({ error: e.message || 'Falha ao iniciar login biométrico.' });
      }
    })
  );

  app.post(
    '/api/webauthn/login/verify',
    limiter,
    asyncHandler(async (req, res) => {
      const db = getDb();
      await ensureWebAuthnSchema(db);
      const { challengeId, credentialId, clientDataJSON, authenticatorData, signature } =
        req.body || {};
      try {
        const { user } = await finishAuthentication(db, {
          challengeId: String(challengeId),
          credentialId: String(credentialId),
          clientDataJSON: String(clientDataJSON),
          authenticatorData: String(authenticatorData),
          signature: String(signature),
        });

        const tokenPayload = {
          id: user.id,
          nome_funcionario: user.nome_funcionario,
          empresa_id: user.empresa_id,
        };
        const token = signAccessToken(tokenPayload);
        setAuthCookie(res, token);
        res.json({
          success: true,
          token,
          tokenPayload,
          auth: 'webauthn',
        });
      } catch (e: any) {
        res.status(401).json({ error: e.message || 'Biometria rejeitada.' });
      }
    })
  );

  app.get(
    '/api/webauthn/credentials',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const db = getDb();
      await ensureWebAuthnSchema(db);
      if (!req.user?.id) return res.status(401).json({ error: 'Não autenticado.' });
      const list = await listCredentials(db, req.user.id);
      res.json({ credentials: list });
    })
  );

  app.delete(
    '/api/webauthn/credentials/:id',
    autenticarToken,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const db = getDb();
      await ensureWebAuthnSchema(db);
      if (!req.user?.id) return res.status(401).json({ error: 'Não autenticado.' });
      const ok = await deleteCredential(db, req.user.id, String(req.params.id));
      if (!ok) return res.status(404).json({ error: 'Credential não encontrada.' });
      res.json({ success: true });
    })
  );
}
