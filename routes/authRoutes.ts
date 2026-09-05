import type { Express, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { getDb } from '../lib/db.js';
import { setAuthCookie, clearAuthCookie, requireJwtSecret } from '../lib/auth.js';
import { validateBody, schemaLoginEmpresa } from '../middleware/validate.js';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas de login.' },
});

export function mountAuthRoutes(app: Express) {
  app.post(
    '/api/auth/login',
    loginLimiter,
    validateBody(schemaLoginEmpresa),
    async (req: Request, res: Response) => {
      try {
        const db = getDb();
        const cnpj = String(req.body.cnpj);
        const senha = String(req.body.senha);

        const usuario = await db.get('SELECT * FROM usuarios WHERE cnpj = ?', [cnpj]);
        if (!usuario?.senha_hash) return res.status(401).json({ error: 'Credenciais inválidas.' });
        const ok = await bcrypt.compare(senha, usuario.senha_hash);
        if (!ok) return res.status(401).json({ error: 'Credenciais inválidas.' });

        const token = jwt.sign(
          {
            id: usuario.id,
            nome_funcionario: usuario.nome_funcionario,
            empresa_id: usuario.empresa_id,
          },
          requireJwtSecret(),
          { expiresIn: '1d' }
        );
        setAuthCookie(res, token);
        res.json({
          success: true,
          token,
          tokenPayload: {
            id: usuario.id,
            nome_funcionario: usuario.nome_funcionario,
            empresa_id: usuario.empresa_id,
          },
        });
      } catch (e) {
        console.error('login:', e);
        res.status(500).json({ error: 'Erro interno.' });
      }
    }
  );

  app.post('/api/auth/logout', (_req, res) => {
    clearAuthCookie(res);
    res.json({ success: true });
  });
}
