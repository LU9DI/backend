/**
 * Autenticação multifator (TOTP) — painel admin Filtra.IA
 * Implementação RFC 6238 em Node puro.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import type { Database } from 'sqlite';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(str: string): Buffer {
  const cleaned = str.replace(/=+$/, '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of cleaned) {
    const idx = B32.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter & 0xffffffff, 4);
  const hmac = crypto.createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function verifyTotp(secretBase32: string, token: string, window = 1): boolean {
  const clean = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    if (hotp(secret, counter + w) === clean) return true;
  }
  return false;
}

export function buildOtpauthUrl(opts: {
  secret: string;
  email: string;
  issuer?: string;
}): string {
  const issuer = encodeURIComponent(opts.issuer || 'Filtra.IA Admin');
  const label = encodeURIComponent(`${opts.issuer || 'Filtra.IA'}:${opts.email}`);
  return `otpauth://totp/${label}?secret=${opts.secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

function generateBackupCodes(n = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    codes.push(crypto.randomBytes(4).toString('hex'));
  }
  return codes;
}

export async function ensureMfaColumns(db: Database): Promise<void> {
  const cols = (await db.all(`PRAGMA table_info(usuarios)`)).map((c: any) => c.name);
  if (!cols.includes('mfa_secret')) await db.exec(`ALTER TABLE usuarios ADD COLUMN mfa_secret TEXT`);
  if (!cols.includes('mfa_enabled')) {
    await db.exec(`ALTER TABLE usuarios ADD COLUMN mfa_enabled INTEGER DEFAULT 0`);
  }
  if (!cols.includes('mfa_backup_hashes')) {
    await db.exec(`ALTER TABLE usuarios ADD COLUMN mfa_backup_hashes TEXT`);
  }
  if (!cols.includes('mfa_pending_secret')) {
    await db.exec(`ALTER TABLE usuarios ADD COLUMN mfa_pending_secret TEXT`);
  }
}

function isAdminUser(u: any): boolean {
  const adminMail = (process.env.ADMIN_EMAIL || 'admin@seusaas.com').trim().toLowerCase();
  return u?.empresa_id === 'admin' || String(u?.email || '').toLowerCase() === adminMail;
}

const mfaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas MFA. Aguarde alguns minutos.' },
});

export function mountMfaRoutes(
  app: Express,
  getDb: () => Database,
  opts: {
    JWT_SECRET: string;
    setAuthCookie: (res: Response, token: string) => void;
    autenticarToken: (req: any, res: Response, next: NextFunction) => void;
  }
) {
  app.post('/api/admin/mfa/setup', opts.autenticarToken, mfaLimiter, async (req: any, res: Response) => {
    try {
      const db = getDb();
      await ensureMfaColumns(db);
      const usuario = await db.get('SELECT * FROM usuarios WHERE id = ?', [req.user?.id]);
      if (!usuario || !isAdminUser(usuario)) {
        return res.status(403).json({ error: 'Apenas o admin pode configurar MFA.' });
      }
      if (usuario.mfa_enabled) {
        return res.status(400).json({ error: 'MFA já está ativo. Desative antes de reconfigurar.' });
      }
      const secret = generateTotpSecret();
      await db.run('UPDATE usuarios SET mfa_pending_secret = ? WHERE id = ?', [secret, usuario.id]);
      const otpauth_url = buildOtpauthUrl({
        secret,
        email: usuario.email || 'admin@seusaas.com',
        issuer: 'Filtra.IA Admin',
      });
      return res.json({
        success: true,
        secret,
        otpauth_url,
        message: 'Escaneie o QR no autenticador e confirme com um código de 6 dígitos.',
      });
    } catch (e) {
      console.error('mfa setup:', e);
      return res.status(500).json({ error: 'Erro interno.' });
    }
  });

  app.post('/api/admin/mfa/confirm', opts.autenticarToken, mfaLimiter, async (req: any, res: Response) => {
    try {
      const code = String(req.body.code || req.body.token || '').trim();
      const db = getDb();
      await ensureMfaColumns(db);
      const usuario = await db.get('SELECT * FROM usuarios WHERE id = ?', [req.user?.id]);
      if (!usuario || !isAdminUser(usuario)) {
        return res.status(403).json({ error: 'Acesso negado.' });
      }
      if (!usuario.mfa_pending_secret) {
        return res.status(400).json({ error: 'Inicie o setup MFA primeiro.' });
      }
      if (!verifyTotp(usuario.mfa_pending_secret, code)) {
        return res.status(401).json({ error: 'Código inválido. Tente o código atual do autenticador.' });
      }
      const backups = generateBackupCodes(8);
      const hashes = await Promise.all(backups.map((c) => bcrypt.hash(c, 10)));
      await db.run(
        `UPDATE usuarios SET mfa_secret = ?, mfa_enabled = 1, mfa_pending_secret = NULL, mfa_backup_hashes = ? WHERE id = ?`,
        [usuario.mfa_pending_secret, JSON.stringify(hashes), usuario.id]
      );
      return res.json({
        success: true,
        message: 'MFA ativado. Guarde os códigos de backup.',
        backup_codes: backups,
      });
    } catch (e) {
      console.error('mfa confirm:', e);
      return res.status(500).json({ error: 'Erro interno.' });
    }
  });

  app.get('/api/admin/mfa/status', opts.autenticarToken, async (req: any, res: Response) => {
    try {
      const db = getDb();
      await ensureMfaColumns(db);
      const usuario = await db.get('SELECT mfa_enabled FROM usuarios WHERE id = ?', [req.user?.id]);
      return res.json({ enabled: !!(usuario && usuario.mfa_enabled) });
    } catch {
      return res.status(500).json({ error: 'Erro interno.' });
    }
  });

  app.post('/api/admin/mfa/disable', opts.autenticarToken, mfaLimiter, async (req: any, res: Response) => {
    try {
      const code = String(req.body.code || '').trim();
      const db = getDb();
      await ensureMfaColumns(db);
      const usuario = await db.get('SELECT * FROM usuarios WHERE id = ?', [req.user?.id]);
      if (!usuario || !isAdminUser(usuario)) {
        return res.status(403).json({ error: 'Acesso negado.' });
      }
      if (!usuario.mfa_enabled) {
        return res.json({ success: true, message: 'MFA já estava desativado.' });
      }
      const totpOk = usuario.mfa_secret && verifyTotp(usuario.mfa_secret, code);
      let backupOk = false;
      let backupHashes: string[] = [];
      try {
        backupHashes = JSON.parse(usuario.mfa_backup_hashes || '[]');
      } catch {
        backupHashes = [];
      }
      if (!totpOk && code) {
        for (let i = 0; i < backupHashes.length; i++) {
          if (await bcrypt.compare(code.toLowerCase(), backupHashes[i])) {
            backupOk = true;
            backupHashes.splice(i, 1);
            break;
          }
        }
      }
      if (!totpOk && !backupOk) {
        return res.status(401).json({ error: 'Código MFA ou backup inválido.' });
      }
      await db.run(
        `UPDATE usuarios SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_hashes = NULL, mfa_pending_secret = NULL WHERE id = ?`,
        [usuario.id]
      );
      return res.json({ success: true, message: 'MFA desativado.' });
    } catch (e) {
      console.error('mfa disable:', e);
      return res.status(500).json({ error: 'Erro interno.' });
    }
  });

  app.post('/api/admin/mfa/verify', mfaLimiter, async (req: Request, res: Response) => {
    try {
      const mfaToken = String(req.body.mfa_token || '').trim();
      const code = String(req.body.code || '').trim();
      if (!mfaToken || !code) {
        return res.status(400).json({ error: 'mfa_token e code são obrigatórios.' });
      }

      let payload: any;
      try {
        payload = jwt.verify(mfaToken, opts.JWT_SECRET) as any;
      } catch {
        return res.status(401).json({ error: 'Sessão MFA expirada. Faça login novamente.' });
      }
      if (payload.purpose !== 'mfa_challenge' || !payload.id) {
        return res.status(401).json({ error: 'Token MFA inválido.' });
      }

      const db = getDb();
      await ensureMfaColumns(db);
      const usuario = await db.get('SELECT * FROM usuarios WHERE id = ?', [payload.id]);
      if (!usuario || !isAdminUser(usuario) || !usuario.mfa_enabled) {
        return res.status(401).json({ error: 'MFA não disponível para este usuário.' });
      }

      let ok = !!(usuario.mfa_secret && verifyTotp(usuario.mfa_secret, code));

      if (!ok) {
        let hashes: string[] = [];
        try {
          hashes = JSON.parse(usuario.mfa_backup_hashes || '[]');
        } catch {
          hashes = [];
        }
        for (let i = 0; i < hashes.length; i++) {
          if (await bcrypt.compare(code.toLowerCase(), hashes[i])) {
            ok = true;
            hashes.splice(i, 1);
            await db.run('UPDATE usuarios SET mfa_backup_hashes = ? WHERE id = ?', [
              JSON.stringify(hashes),
              usuario.id,
            ]);
            break;
          }
        }
      }

      if (!ok) {
        return res.status(401).json({ error: 'Código inválido.' });
      }

      const session = jwt.sign(
        {
          id: usuario.id,
          nome_funcionario: usuario.nome_funcionario,
          empresa_id: usuario.empresa_id,
          role: 'admin',
          mfa: true,
        },
        opts.JWT_SECRET,
        { expiresIn: '1d' }
      );
      opts.setAuthCookie(res, session);

      return res.json({
        success: true,
        token: session,
        tokenPayload: {
          id: usuario.id,
          nome_funcionario: usuario.nome_funcionario,
          empresa_id: usuario.empresa_id,
          role: 'admin',
        },
      });
    } catch (e) {
      console.error('mfa verify:', e);
      return res.status(500).json({ error: 'Erro interno.' });
    }
  });
}

export function issueMfaChallenge(
  usuario: any,
  JWT_SECRET: string
): { mfa_required: true; mfa_token: string } {
  const mfa_token = jwt.sign(
    { id: usuario.id, purpose: 'mfa_challenge' },
    JWT_SECRET,
    { expiresIn: '5m' }
  );
  return { mfa_required: true, mfa_token };
}

export async function userHasMfa(db: Database, usuarioId: string): Promise<boolean> {
  await ensureMfaColumns(db);
  const u = await db.get('SELECT mfa_enabled FROM usuarios WHERE id = ?', [usuarioId]);
  return !!(u && u.mfa_enabled);
}

