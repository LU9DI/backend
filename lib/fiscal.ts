import type { Database } from 'sqlite';
import crypto from 'node:crypto';

export type FiscalStatus =
  | 'pending'
  | 'processing'
  | 'authorized'
  | 'rejected'
  | 'cancelled'
  | 'aguardando_dados_fiscais';

type FiscalConfig = {
  enabled: boolean;
  provider: 'focus_nfe';
  token: string;
  baseUrl: string;
  municipioPrestacao: string;
  codigoTributacaoNacionalIss: string;
  descricaoServico: string;
  codigoOpcaoSimplesNacional: string;
  regimeEspecialTributacao: string;
  tributacaoIss: number;
};

function env(name: string, fallback = ''): string {
  return String(process.env[name] || fallback).trim();
}

export function fiscalConfig(): FiscalConfig {
  return {
    enabled: env('FISCAL_ENABLED') === '1',
    provider: 'focus_nfe',
    token: env('FOCUS_NFE_TOKEN'),
    baseUrl: env('FOCUS_NFE_ENV') === 'producao'
      ? 'https://api.focusnfe.com.br'
      : 'https://homologacao.focusnfe.com.br',
    municipioPrestacao: env('FISCAL_CODIGO_MUNICIPIO'),
    codigoTributacaoNacionalIss: env('FISCAL_CODIGO_TRIBUTACAO_ISS'),
    descricaoServico: env('FISCAL_DESCRICAO_SERVICO', 'Prestação de serviços de software Filtra.AI'),
    codigoOpcaoSimplesNacional: env('FISCAL_CODIGO_SIMPLES', '1'),
    regimeEspecialTributacao: env('FISCAL_REGIME_ESPECIAL', '0'),
    tributacaoIss: Number(env('FISCAL_TRIBUTACAO_ISS', '1')) || 1,
  };
}

export function fiscalConfigured(): boolean {
  const c = fiscalConfig();
  return c.enabled && !!c.token;
}

export async function ensureFiscalSchema(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS fiscal_documents (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      payment_reference TEXT NOT NULL,
      idempotency_key TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL,
      provider_ref TEXT,
      status TEXT NOT NULL,
      valor NUMERIC NOT NULL DEFAULT 0,
      competencia TEXT,
      numero_nfse TEXT,
      codigo_verificacao TEXT,
      chave_acesso TEXT,
      xml TEXT,
      pdf_url TEXT,
      erro_codigo TEXT,
      erro_mensagem TEXT,
      tentativas INTEGER NOT NULL DEFAULT 0,
      next_retry_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      authorized_at TIMESTAMPTZ
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_fiscal_empresa ON fiscal_documents(empresa_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_fiscal_status ON fiscal_documents(status)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_fiscal_provider_ref ON fiscal_documents(provider, provider_ref)');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS fiscal_recipient_profiles (
      empresa_id TEXT PRIMARY KEY,
      nome TEXT,
      cpf TEXT,
      cnpj TEXT,
      email TEXT,
      codigo_municipio TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function cleanDoc(value: unknown): string {
  return String(value || '').replace(/\\D/g, '');
}

function makeReference(id: string): string {
  return ('filtra' + id.replace(/[^a-zA-Z0-9]/g, '')).slice(0, 48);
}

async function getRecipient(db: Database, empresaId: string) {
  return db.get(
    'SELECT * FROM fiscal_recipient_profiles WHERE empresa_id = ?',
    [empresaId]
  );
}

async function getCompany(db: Database, empresaId: string) {
  return db.get(
    'SELECT id, nome_empresa, cnpj, slug FROM empresas WHERE id = ?',
    [empresaId]
  );
}

export async function upsertFiscalRecipient(
  db: Database,
  empresaId: string,
  input: { nome?: string; cpf?: string; cnpj?: string; email?: string; codigo_municipio?: string }
) {
  const nome = String(input.nome || '').trim().slice(0, 200) || null;
  const cpf = cleanDoc(input.cpf).slice(0, 11) || null;
  const cnpj = cleanDoc(input.cnpj).slice(0, 14) || null;
  const email = String(input.email || '').trim().toLowerCase().slice(0, 254) || null;
  const codigoMunicipio = cleanDoc(input.codigo_municipio).slice(0, 7) || null;

  const existing = await getRecipient(db, empresaId);
  if (existing) {
    await db.run(
      `UPDATE fiscal_recipient_profiles
       SET nome = ?, cpf = ?, cnpj = ?, email = ?, codigo_municipio = ?, updated_at = CURRENT_TIMESTAMP
       WHERE empresa_id = ?`,
      [nome, cpf, cnpj, email, codigoMunicipio, empresaId]
    );
  } else {
    await db.run(
      `INSERT INTO fiscal_recipient_profiles
       (empresa_id, nome, cpf, cnpj, email, codigo_municipio)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [empresaId, nome, cpf, cnpj, email, codigoMunicipio]
    );
  }
  return getRecipient(db, empresaId);
}

function recipientReady(recipient: any): boolean {
  if (!recipient) return false;
  const doc = cleanDoc(recipient.cnpj) || cleanDoc(recipient.cpf);
  return !!(doc && recipient.nome && recipient.email && recipient.codigo_municipio);
}

function extractProviderError(body: any): { code: string | null; message: string } {
  const message =
    body?.mensagem ||
    body?.message ||
    body?.erro ||
    body?.error ||
    body?.errors?.[0]?.mensagem ||
    body?.errors?.[0]?.message ||
    'Falha na comunicação fiscal';
  return {
    code: body?.codigo || body?.code || body?.errors?.[0]?.codigo || null,
    message: String(message).slice(0, 1000),
  };
}

async function focusRequest(
  config: FiscalConfig,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const auth = Buffer.from(config.token + ':').toString('base64');
  const response = await fetch(config.baseUrl + path, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + auth,
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: response.status, body };
}

async function emitNationalNfse(
  config: FiscalConfig,
  reference: string,
  company: any,
  recipient: any,
  amount: number
) {
  const recipientDoc = cleanDoc(recipient.cnpj) || cleanDoc(recipient.cpf);
  const body: Record<string, unknown> = {
    data_emissao: new Date().toISOString(),
    data_competencia: new Date().toISOString().slice(0, 10),
    serie_dps: 1,
    emitente_dps: 1,
    codigo_municipio_emissora: Number(config.municipioPrestacao),
    cnpj_prestador: cleanDoc(company.cnpj),
    codigo_opcao_simples_nacional: config.codigoOpcaoSimplesNacional,
    regime_especial_tributacao: config.regimeEspecialTributacao,
    codigo_municipio_prestacao: config.municipioPrestacao,
    codigo_tributacao_nacional_iss: config.codigoTributacaoNacionalIss,
    descricao_servico: config.descricaoServico,
    valor_servico: Number(amount.toFixed(2)),
    tributacao_iss: config.tributacaoIss,
  };

  if (cleanDoc(recipient.cnpj)) body.cnpj_tomador = recipientDoc;
  else body.cpf_tomador = recipientDoc;

  const result = await focusRequest(
    config,
    '/v2/nfsen?ref=' + encodeURIComponent(reference),
    { method: 'POST', body: JSON.stringify(body) }
  );

  if (result.status < 200 || result.status >= 300) {
    const err = extractProviderError(result.body);
    throw new Error(err.code ? `[${err.code}] ${err.message}` : err.message);
  }

  return result.body;
}

export async function createFiscalDocumentForPayment(
  db: Database,
  empresaId: string,
  paymentReference: string,
  amount: number
): Promise<{ id: string; status: FiscalStatus }> {
  const company = await getCompany(db, empresaId);
  if (!company) return { id: '', status: 'aguardando_dados_fiscais' };

  const idempotencyKey = crypto
    .createHash('sha256')
    .update(`${empresaId}:${paymentReference}`)
    .digest('hex');
  const existing = await db.get(
    'SELECT id, status FROM fiscal_documents WHERE idempotency_key = ?',
    [idempotencyKey]
  );
  if (existing) return existing as { id: string; status: FiscalStatus };

  const recipient = await getRecipient(db, empresaId);
  const ready = !!recipient && recipientReady(recipient);
  const status: FiscalStatus = fiscalConfigured() && ready ? 'pending' : 'aguardando_dados_fiscais';
  const id = crypto.randomUUID();
  const providerRef = makeReference(id);

  await db.run(
    `INSERT INTO fiscal_documents
     (id, empresa_id, payment_reference, idempotency_key, provider, provider_ref, status, valor)
     VALUES (?, ?, ?, ?, 'focus_nfe', ?, ?, ?)`,
    [id, empresaId, paymentReference, idempotencyKey, providerRef, status, Number(amount) || 0]
  );

  return { id, status };
}

export async function processFiscalDocument(db: Database, id: string): Promise<void> {
  const config = fiscalConfig();
  const doc = await db.get('SELECT * FROM fiscal_documents WHERE id = ?', [id]);
  if (!doc) throw new Error('Documento fiscal não encontrado.');

  if (!config.enabled || !config.token) {
    await db.run(
      `UPDATE fiscal_documents SET status = 'aguardando_dados_fiscais', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    );
    return;
  }

  const company = await getCompany(db, doc.empresa_id);
  const recipient = await getRecipient(db, doc.empresa_id);
  if (!company || !recipient || !recipientReady(recipient)) {
    await db.run(
      `UPDATE fiscal_documents
       SET status = 'aguardando_dados_fiscais', erro_mensagem = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      ['Dados fiscais do tomador incompletos.', id]
    );
    return;
  }

  await db.run(
    `UPDATE fiscal_documents
     SET status = 'processing', tentativas = tentativas + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [id]
  );

  try {
    const result = await emitNationalNfse(
      config,
      String(doc.provider_ref),
      company,
      recipient,
      Number(doc.valor) || 0
    );

    const status = String(result?.status || '').toLowerCase();
    if (status === 'autorizada' || status === 'authorized') {
      await db.run(
        `UPDATE fiscal_documents
         SET status = 'authorized',
             numero_nfse = ?,
             codigo_verificacao = ?,
             chave_acesso = ?,
             xml = ?,
             pdf_url = ?,
             erro_codigo = NULL,
             erro_mensagem = NULL,
             authorized_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          result?.numero || result?.numero_nfse || null,
          result?.codigo_verificacao || null,
          result?.chave_acesso || result?.chave || null,
          result?.xml || null,
          result?.pdf || result?.pdf_url || result?.danfse || null,
          id,
        ]
      );
      return;
    }

    await db.run(
      `UPDATE fiscal_documents
       SET status = 'processing', erro_codigo = NULL, erro_mensagem = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [id]
    );
  } catch (e: any) {
    const message = String(e?.message || e).slice(0, 1000);
    await db.run(
      `UPDATE fiscal_documents
       SET status = 'rejected', erro_mensagem = ?, next_retry_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [message, new Date(Date.now() + 15 * 60 * 1000).toISOString(), id]
    );
    throw e;
  }
}

export async function syncFiscalDocument(db: Database, reference: string): Promise<void> {
  const config = fiscalConfig();
  if (!config.enabled || !config.token) return;

  const doc = await db.get(
    'SELECT * FROM fiscal_documents WHERE provider = ? AND provider_ref = ?',
    ['focus_nfe', reference]
  );
  if (!doc) return;

  const result = await focusRequest(
    config,
    '/v2/nfsen/' + encodeURIComponent(reference),
    { method: 'GET' }
  );

  if (result.status === 404) return;
  if (result.status < 200 || result.status >= 300) {
    const err = extractProviderError(result.body);
    throw new Error(err.message);
  }

  const status = String(result.body?.status || '').toLowerCase();
  if (status === 'autorizada' || status === 'authorized') {
    await db.run(
      `UPDATE fiscal_documents
       SET status = 'authorized',
           numero_nfse = ?,
           codigo_verificacao = ?,
           chave_acesso = ?,
           xml = ?,
           pdf_url = ?,
           erro_codigo = NULL,
           erro_mensagem = NULL,
           authorized_at = COALESCE(authorized_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        result.body?.numero || result.body?.numero_nfse || null,
        result.body?.codigo_verificacao || null,
        result.body?.chave_acesso || result.body?.chave || null,
        result.body?.xml || null,
        result.body?.pdf || result.body?.pdf_url || result.body?.danfse || null,
        doc.id,
      ]
    );
  } else if (/erro|rejeit|cancelad/i.test(status)) {
    await db.run(
      `UPDATE fiscal_documents
       SET status = ?, erro_mensagem = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status.includes('cancel') ? 'cancelled' : 'rejected', String(result.body?.mensagem || result.body?.message || status).slice(0, 1000), doc.id]
    );
  }
}

export async function listFiscalDocuments(db: Database, empresaId: string, limit = 50) {
  return db.all(
    `SELECT id, payment_reference, provider, provider_ref, status, valor, competencia,
            numero_nfse, codigo_verificacao, chave_acesso, pdf_url,
            erro_codigo, erro_mensagem, tentativas, next_retry_at,
            created_at, updated_at, authorized_at
     FROM fiscal_documents
     WHERE empresa_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [empresaId, Math.max(1, Math.min(100, Number(limit) || 50))]
  );
}
