/**
 * WebAuthn / passkey / biometria (digital, Face ID, Windows Hello).
 *
 * A biometria NUNCA sai do dispositivo — só a assinatura criptográfica.
 *
 * Segurança:
 *  - challenge de uso único + TTL curto
 *  - RP ID e Origin fixos (anti phishing)
 *  - userVerification = required
 *  - contador de assinatura (detecta cópia de credential)
 *  - máx. credentials por usuário
 *  - rate limit nas rotas
 *
 * Env (opcional — se omitir, deriva de FRONTEND_URL / APP_URL):
 *   WEBAUTHN_RP_ID=seudominio.com
 *   WEBAUTHN_RP_NAME=Filtra.IA
 *   WEBAUTHN_ORIGIN=https://seudominio.com
 *   WEBAUTHN_MAX_CREDENTIALS=5
 */
import crypto from 'crypto';
import type { Database } from 'sqlite';

export type WebAuthnCredentialRow = {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  device_name: string | null;
  transports: string | null;
  created_at: string;
  last_used_at: string | null;
};

const challenges = new Map<
  string,
  { challenge: string; userId?: string; cnpj?: string; type: 'reg' | 'auth'; expires: number }
>();

function frontBase(): string {
  return (
    process.env.WEBAUTHN_ORIGIN ||
    process.env.APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.CORS_ORIGINS?.split(',')[0] ||
    'http://localhost:3000'
  )
    .trim()
    .replace(/\/$/, '');
}

function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'localhost';
  }
}

function rpId(): string {
  const explicit = process.env.WEBAUTHN_RP_ID?.trim();
  if (explicit) return explicit;
  // Produção: hostname do front (ex.: filtra-ia.vercel.app)
  return hostnameFromUrl(frontBase());
}

function rpName(): string {
  return (process.env.WEBAUTHN_RP_NAME || 'Filtra.IA').trim();
}

function expectedOrigin(): string {
  return frontBase();
}

function maxCreds(): number {
  return Math.max(1, Number(process.env.WEBAUTHN_MAX_CREDENTIALS || 5));
}

export function webauthnConfig() {
  const origin = expectedOrigin();
  const id = rpId();
  const productionReady =
    id !== 'localhost' &&
    !origin.includes('localhost') &&
    (origin.startsWith('https://') || origin.startsWith('http://127.'));
  return {
    rpId: id,
    rpName: rpName(),
    origin,
    maxCredentials: maxCreds(),
    enabled: productionReady || process.env.NODE_ENV !== 'production',
    production_ready: productionReady,
  };
}

export async function ensureWebAuthnSchema(db: Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      credential_id TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      device_name TEXT,
      transports TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES usuarios(id)
    );
  `);
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id)`
  );
}

function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

export function createChallenge(
  type: 'reg' | 'auth',
  opts: { userId?: string; cnpj?: string }
): { challengeId: string; challenge: string } {
  const challenge = b64url(crypto.randomBytes(32));
  const challengeId = crypto.randomUUID();
  challenges.set(challengeId, {
    challenge,
    userId: opts.userId,
    cnpj: opts.cnpj,
    type,
    expires: Date.now() + 5 * 60 * 1000,
  });
  for (const [k, v] of challenges) {
    if (v.expires < Date.now()) challenges.delete(k);
  }
  return { challengeId, challenge };
}

export function consumeChallenge(
  challengeId: string,
  expectedType: 'reg' | 'auth'
): { challenge: string; userId?: string; cnpj?: string } {
  const row = challenges.get(challengeId);
  if (!row) throw new Error('Challenge inválido ou expirado.');
  challenges.delete(challengeId);
  if (row.expires < Date.now()) throw new Error('Challenge expirado. Tente novamente.');
  if (row.type !== expectedType) throw new Error('Tipo de challenge incorreto.');
  return { challenge: row.challenge, userId: row.userId, cnpj: row.cnpj };
}

export async function listCredentials(db: Database, userId: string) {
  return db.all(
    `SELECT id, credential_id, device_name, transports, created_at, last_used_at, counter
     FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC`,
    [userId]
  );
}

export async function countCredentials(db: Database, userId: string): Promise<number> {
  const r = await db.get(
    `SELECT COUNT(*) as c FROM webauthn_credentials WHERE user_id = ?`,
    [userId]
  );
  return Number(r?.c || 0);
}

export async function findCredentialByCredId(
  db: Database,
  credentialId: string
): Promise<WebAuthnCredentialRow | undefined> {
  return db.get(`SELECT * FROM webauthn_credentials WHERE credential_id = ?`, [credentialId]);
}

export async function registrationOptions(
  db: Database,
  user: { id: string; nome: string; cnpj: string }
) {
  const n = await countCredentials(db, user.id);
  if (n >= maxCreds()) {
    throw new Error(`Limite de ${maxCreds()} digitais por conta atingido. Remova uma antes.`);
  }
  const existing = await listCredentials(db, user.id);
  const { challengeId, challenge } = createChallenge('reg', { userId: user.id });

  return {
    challengeId,
    publicKey: {
      challenge,
      rp: { id: rpId(), name: rpName() },
      user: {
        id: b64url(Buffer.from(user.id)),
        name: user.cnpj || user.id,
        displayName: user.nome || 'Usuário',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: 120000,
      attestation: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
        requireResidentKey: false,
      },
      excludeCredentials: existing.map((c: any) => ({
        type: 'public-key',
        id: c.credential_id,
        transports: c.transports ? JSON.parse(c.transports) : undefined,
      })),
    },
  };
}

export async function finishRegistration(
  db: Database,
  opts: {
    challengeId: string;
    userId: string;
    credentialId: string;
    publicKey: string;
    clientDataJSON: string;
    deviceName?: string;
    transports?: string[];
  }
) {
  const ch = consumeChallenge(opts.challengeId, 'reg');
  if (ch.userId && ch.userId !== opts.userId) {
    throw new Error('Challenge não pertence a este usuário.');
  }

  const clientData = JSON.parse(fromB64url(opts.clientDataJSON).toString('utf8'));
  if (clientData.type !== 'webauthn.create') {
    throw new Error('clientData.type inválido.');
  }
  if (clientData.challenge !== ch.challenge) {
    throw new Error('Challenge não confere (possível replay).');
  }
  const origin = String(clientData.origin || '').replace(/\/$/, '');
  if (origin !== expectedOrigin()) {
    throw new Error(`Origin inválida: ${origin} (esperado ${expectedOrigin()}).`);
  }

  const credId = opts.credentialId;
  if (!credId || !opts.publicKey) throw new Error('credentialId/publicKey ausentes.');

  const exists = await findCredentialByCredId(db, credId);
  if (exists) throw new Error('Esta digital já está registrada.');

  const n = await countCredentials(db, opts.userId);
  if (n >= maxCreds()) throw new Error('Limite de digitais atingido.');

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO webauthn_credentials
     (id, user_id, credential_id, public_key, counter, device_name, transports, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    [
      id,
      opts.userId,
      credId,
      opts.publicKey,
      opts.deviceName || 'Dispositivo',
      opts.transports ? JSON.stringify(opts.transports) : null,
      now,
    ]
  );
  return { id, credentialId: credId };
}

export async function authenticationOptions(db: Database, cnpj: string) {
  const user = await db.get('SELECT * FROM usuarios WHERE cnpj = ?', [cnpj]);
  if (!user) throw new Error('CNPJ não encontrado.');
  const creds = await listCredentials(db, user.id);
  if (!creds.length) {
    throw new Error('Nenhuma digital cadastrada. Entre com senha e registre a digital no painel.');
  }
  const { challengeId, challenge } = createChallenge('auth', { userId: user.id, cnpj });
  return {
    challengeId,
    publicKey: {
      challenge,
      timeout: 120000,
      rpId: rpId(),
      userVerification: 'required',
      allowCredentials: creds.map((c: any) => ({
        type: 'public-key',
        id: c.credential_id,
        transports: c.transports ? JSON.parse(c.transports) : ['internal'],
      })),
    },
  };
}

export async function finishAuthentication(
  db: Database,
  opts: {
    challengeId: string;
    credentialId: string;
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
  }
): Promise<{ user: any }> {
  const ch = consumeChallenge(opts.challengeId, 'auth');
  const cred = await findCredentialByCredId(db, opts.credentialId);
  if (!cred) throw new Error('Digital não reconhecida.');
  if (ch.userId && ch.userId !== cred.user_id) {
    throw new Error('Credential não corresponde ao challenge.');
  }

  const clientDataBuf = fromB64url(opts.clientDataJSON);
  const clientData = JSON.parse(clientDataBuf.toString('utf8'));
  if (clientData.type !== 'webauthn.get') throw new Error('clientData.type inválido.');
  if (clientData.challenge !== ch.challenge) throw new Error('Challenge não confere.');
  const origin = String(clientData.origin || '').replace(/\/$/, '');
  if (origin !== expectedOrigin()) {
    throw new Error(`Origin inválida: ${origin}`);
  }

  const authData = fromB64url(opts.authenticatorData);
  if (authData.length < 37) throw new Error('authenticatorData inválido.');

  const rpHash = authData.subarray(0, 32);
  const expectedRpHash = crypto.createHash('sha256').update(rpId()).digest();
  if (!rpHash.equals(expectedRpHash)) {
    throw new Error('RP ID hash não confere (anti-phishing).');
  }

  const flags = authData[32];
  const userPresent = (flags & 0x01) !== 0;
  const userVerified = (flags & 0x04) !== 0;
  if (!userPresent) throw new Error('Usuário não presente no autenticador.');
  if (!userVerified) throw new Error('Verificação biométrica obrigatória não satisfeita.');

  const counter = authData.readUInt32BE(33);
  if (counter > 0 && counter <= Number(cred.counter)) {
    throw new Error('Possível clone de credential detectado (contador).');
  }

  const clientHash = crypto.createHash('sha256').update(clientDataBuf).digest();
  const signed = Buffer.concat([authData, clientHash]);
  const signature = fromB64url(opts.signature);

  const ok = verifyWebAuthnSignature(cred.public_key, signed, signature);
  if (!ok) throw new Error('Assinatura biométrica inválida.');

  await db.run(
    `UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?`,
    [Math.max(counter, Number(cred.counter) + 1), new Date().toISOString(), cred.id]
  );

  const user = await db.get('SELECT * FROM usuarios WHERE id = ?', [cred.user_id]);
  if (!user) throw new Error('Usuário não encontrado.');
  return { user };
}

function verifyWebAuthnSignature(
  publicKeyB64: string,
  data: Buffer,
  signature: Buffer
): boolean {
  try {
    let keyInput = publicKeyB64.trim();
    let keyObject: crypto.KeyObject;
    if (keyInput.includes('BEGIN')) {
      keyObject = crypto.createPublicKey(keyInput);
    } else {
      const der = fromB64url(keyInput);
      keyObject = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    }

    try {
      return crypto.verify(null, data, keyObject, signature);
    } catch {
      /* fallthrough */
    }
    try {
      return crypto.verify('SHA256', data, keyObject, signature);
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

export async function deleteCredential(db: Database, userId: string, credentialRowId: string) {
  const r = await db.run(
    `DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?`,
    [credentialRowId, userId]
  );
  return (r as any).changes > 0;
}
