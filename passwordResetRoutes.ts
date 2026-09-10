/**
 * Recuperação de senha por e-mail (clientes / empresas).
 * Admin: ver adminPasswordReset.ts
 */
import type { Express, Request, Response } from 'express';
import type { Database } from 'sqlite';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { enviarEmail, smtpConfigured } from './lib/mailer.js';
import { validarSenhaEmpresa } from './passwordPolicy.js';

const APP_URL = (process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(
  /\/$/,
  ''
);

function normalizarCnpj(cnpj: string): string {
  return String(cnpj || '').replace(/\D/g, '');
}

function emailValido(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isAdminAccount(usuario: any): boolean {
  if (!usuario) return false;
  const adminMail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const email = String(usuario.email || '').toLowerCase();
  if (usuario.empresa_id === 'admin') return true;
  if (adminMail && email === adminMail) return true;
  return false;
}

export async function invalidatePasswordResetTokens(
  db: Database,
  usuarioId: string
): Promise<number> {
  const result = await db.run(
    `UPDATE password_resets SET usado = 1 WHERE usuario_id = ? AND usado = 0`,
    [usuarioId]
  );
  return Number(result.changes || 0);
}

export async function ensureAuthColumns(db: Database) {
  const cols = (await db.all(`PRAGMA table_info(usuarios)`)).map((c: any) => c.name);
  if (!cols.includes('email')) {
    await db.exec(`ALTER TABLE usuarios ADD COLUMN email TEXT`);
  }
  try {
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email)`);
  } catch {
    /* ok */
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expira_em TIMESTAMPTZ NOT NULL,
      usado INTEGER DEFAULT 0,
      criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try {
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_password_resets_usuario ON password_resets(usuario_id, usado)`
    );
  } catch {
    /* ok */
  }
}

export async function createUsuarioForEmpresa(
  db: Database,
  opts: {
    empresaId: string;
    cnpj: string;
    nome: string;
    email: string;
    senha: string;
  }
): Promise<{ id: string }> {
  await ensureAuthColumns(db);
  const email = opts.email.trim().toLowerCase();
  if (!emailValido(email)) throw new Error('E-mail inválido.');

  const pol = validarSenhaEmpresa(opts.senha);
  if (!pol.ok) throw new Error(pol.error);

  const existenteEmail = await db.get('SELECT id FROM usuarios WHERE email = ?', [email]);
  if (existenteEmail) throw new Error('Este e-mail já está em uso.');

  const id = crypto.randomUUID();
  const hash = await bcrypt.hash(opts.senha, 12);
  await db.run(
    `INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash, email)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, normalizarCnpj(opts.cnpj), opts.nome.slice(0, 120), opts.empresaId, hash, email]
  );
  return { id };
}

const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' },
});

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Muitas tentativas. Aguarde alguns minutos.' },
});

export function mountPasswordResetRoutes(app: Express, getDb: () => Database) {
  app.post('/api/auth/forgot-password', forgotLimiter, async (req: Request, res: Response) => {
    try {
      const db = getDb();
      await ensureAuthColumns(db);

      const cnpj = normalizarCnpj(req.body.cnpj || '');
      const email = String(req.body.email || '')
        .trim()
        .toLowerCase();

      const okMsg =
        'Se os dados estiverem corretos, você receberá um e-mail com instruções para redefinir a senha.';

      let usuario: any = null;
      if (email && emailValido(email)) {
        usuario = await db.get('SELECT * FROM usuarios WHERE email = ?', [email]);
      } else if (cnpj.length === 14) {
        usuario = await db.get('SELECT * FROM usuarios WHERE cnpj = ?', [cnpj]);
      } else {
        return res.status(400).json({ error: 'Informe o e-mail cadastrado.' });
      }

      if (usuario && isAdminAccount(usuario)) {
        return res.json({
          success: true,
          message:
            'Contas administrativas usam recuperação protegida em /admin/login (chave do servidor).',
        });
      }

      // Resposta genérica se usuário não existe (anti-enumeration)
      if (!usuario || !usuario.email) {
        return res.json({ success: true, message: okMsg, smtp: smtpConfigured() });
      }

      await invalidatePasswordResetTokens(db, usuario.id);

      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expira = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      await db.run(
        `INSERT INTO password_resets (id, usuario_id, token_hash, expira_em, usado)
         VALUES (?, ?, ?, ?, 0)`,
        [crypto.randomUUID(), usuario.id, tokenHash, expira]
      );

      const link = `${APP_URL}/recuperar-senha?token=${token}`;
      const sent = await enviarEmail({
        to: usuario.email,
        subject: 'Filtra.IA — redefinição de senha',
        text: [
          'Olá,',
          '',
          'Recebemos uma solicitação para redefinir a senha da sua conta Filtra.IA.',
          'Se foi você, acesse o link abaixo (válido por 1 hora):',
          '',
          link,
          '',
          'Links anteriores de recuperação foram invalidados.',
          'Se você não solicitou esta alteração, ignore este e-mail.',
          '',
          '— Equipe Filtra.IA',
        ].join('\n'),
      });

      if (!sent.ok) {
        console.error('[forgot-password] e-mail não enviado:', sent.error || sent.mode);
        // Ainda responde genérico ao cliente (segurança), mas loga falha real no Render
        return res.json({
          success: true,
          message: okMsg,
          smtp: smtpConfigured(),
          delivered: false,
        });
      }

      res.json({
        success: true,
        message: okMsg,
        smtp: true,
        delivered: true,
      });
    } catch (e: any) {
      console.error('forgot-password:', e.message || e);
      res.status(500).json({ error: 'Erro ao processar a solicitação.' });
    }
  });

  app.post('/api/auth/reset-password', resetLimiter, async (req: Request, res: Response) => {
    try {
      const token = String(req.body.token || '').trim();
      const nova = String(req.body.nova_senha || req.body.senha || '');

      if (!token || token.length < 20) {
        return res.status(400).json({ error: 'Token inválido.' });
      }

      const pol = validarSenhaEmpresa(nova);
      if (!pol.ok) {
        return res.status(400).json({ error: pol.error });
      }

      const db = getDb();
      await ensureAuthColumns(db);

      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const row = await db.get(
        `SELECT * FROM password_resets
         WHERE token_hash = ? AND usado = 0
         ORDER BY criado_em DESC LIMIT 1`,
        [tokenHash]
      );

      if (!row) {
        return res.status(400).json({ error: 'Link inválido ou já utilizado.' });
      }
      if (new Date(row.expira_em).getTime() < Date.now()) {
        await db.run('UPDATE password_resets SET usado = 1 WHERE id = ?', [row.id]);
        return res.status(400).json({ error: 'Link expirado. Solicite uma nova recuperação.' });
      }

      const usuario = await db.get('SELECT * FROM usuarios WHERE id = ?', [row.usuario_id]);
      if (usuario && isAdminAccount(usuario)) {
        return res.status(403).json({
          error: 'Use /admin/login para redefinir a senha do administrador.',
        });
      }

      const hash = await bcrypt.hash(nova, 12);
      await db.run('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [hash, row.usuario_id]);

      await db.run('UPDATE password_resets SET usado = 1 WHERE id = ?', [row.id]);
      await invalidatePasswordResetTokens(db, row.usuario_id);

      res.json({ success: true, message: 'Senha atualizada com sucesso. Você já pode entrar.' });
    } catch (e: any) {
      console.error('reset-password:', e.message || e);
      res.status(500).json({ error: 'Erro ao processar a solicitação.' });
    }
  });
}
