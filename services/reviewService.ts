/**
 * Regras de negócio de avaliações (reviews) + anti-fraude + sentimento + push + e-mail.
 */
import type { Database } from 'sqlite';
import { getDb, findEmpresa } from '../lib/db.js';
import {
  gerarRespostaReview,
  gerarTagsSemanticas,
  analisarSentimento,
  aiConfigured,
} from '../groqService.js';
import {
  planTemIA,
  getFeedbackLimit,
  contarReviewsMes,
  assertEmpresaTokenQuota,
} from '../lib/quota.js';
import {
  assertNotHoneypot,
  checkDbRateByIp,
  checkDuplicateComment,
  checkMemoryRate,
  checkOneComplaintOnly,
  ensureReviewFraudColumns,
  hashIp,
  softFraudFlags,
  ReviewFraudError,
} from '../lib/reviewFraud.js';
import { notifyCrisisReview } from '../lib/push.js';
import { normalizarWhatsapp } from '../lib/whatsapp.js';
import { notificarCriticaPrivada, notificarAlertaCrise } from '../lib/notifications.js';
import { normalizeLocale } from '../lib/locale.js';

export type ReviewInput = {
  name?: string;
  comment?: string;
  rating: number;
  empresa_id?: string;
  empresa_ref?: string;
  website?: string;
  is_test?: boolean;
  ip?: string;
  client_whatsapp?: string;
  locale?: string;
};

export type ReviewResult = {
  success: true;
  id: number | undefined;
  ai: boolean;
  is_test?: boolean;
  sentiment?: string;
  ai_skipped_quota?: boolean;
  locale?: string;
};

export class ReviewNotFoundError extends Error {
  status = 404;
  constructor(message = 'Empresa não encontrada.') {
    super(message);
    this.name = 'ReviewNotFoundError';
  }
}

export class ReviewQuotaError extends Error {
  status = 429;
  constructor(message: string) {
    super(message);
    this.name = 'ReviewQuotaError';
  }
}

export class ReviewValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ReviewValidationError';
  }
}

export { ReviewFraudError };

async function ensureSentimentColumns(db: Database) {
  const extras = [
    'sentiment TEXT',
    'sentiment_score DOUBLE PRECISION',
    'sentiment_source TEXT',
    'client_whatsapp TEXT',
    'locale TEXT',
  ];
  for (const ddl of extras) {
    try {
      await db.exec(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS ${ddl}`);
    } catch {
      try {
        await db.exec(`ALTER TABLE reviews ADD COLUMN ${ddl}`);
      } catch {
        /* ok */
      }
    }
  }
}

async function emailDaEmpresa(db: Database, empresaId: string): Promise<string | null> {
  try {
    const row = await db.get(
      `SELECT email FROM usuarios WHERE empresa_id = ? AND email IS NOT NULL AND email != '' LIMIT 1`,
      [empresaId]
    );
    return row?.email ? String(row.email) : null;
  } catch {
    return null;
  }
}

export async function criarReview(
  input: ReviewInput,
  db: Database = getDb()
): Promise<ReviewResult> {
  try {
    await ensureReviewFraudColumns(db);
  } catch (e: any) {
    console.warn('ensureReviewFraudColumns:', e?.message || e);
  }
  try {
    await ensureSentimentColumns(db);
  } catch (e: any) {
    console.warn('ensureSentimentColumns:', e?.message || e);
  }

  assertNotHoneypot(input.website);

  const name = input.name ? String(input.name).slice(0, 100) : '';
  const comment = input.comment ? String(input.comment).slice(0, 500) : '';
  const rating = Number(input.rating);
  const empresaRef = String(input.empresa_id || input.empresa_ref || '').slice(0, 100);
  const isTest = Boolean(input.is_test);
  const ip = input.ip || '0.0.0.0';
  const ipHash = hashIp(ip);
  const locale = normalizeLocale(input.locale);

  let clientWpp: string | null = null;
  if (!isTest && rating <= 3) {
    clientWpp = normalizarWhatsapp(input.client_whatsapp);
    if (!clientWpp) {
      throw new ReviewValidationError(
        'Informe seu WhatsApp/telefone para a empresa poder retornar o contato.'
      );
    }
  }

  let empresaId: string | null = null;
  let nomeEmpresa: string | undefined;
  let plan = 'trial';
  let slugOrId: string | undefined;

  if (empresaRef) {
    const emp = await findEmpresa(empresaRef);
    if (!emp) throw new ReviewNotFoundError();
    empresaId = emp.id;
    nomeEmpresa = emp.nome_empresa;
    plan = String(emp.plan || emp.status || 'trial').toLowerCase();
    slugOrId = emp.slug || emp.id;

    if (!isTest) {
      checkMemoryRate(ip, empresaId!);
      await checkDbRateByIp(db, empresaId!, ipHash);
      if (comment) await checkDuplicateComment(db, empresaId!, comment);
      await checkOneComplaintOnly(db, {
        empresaId: empresaId!,
        ipHash,
        clientWhatsapp: clientWpp,
        rating,
      });

      const usadas = await contarReviewsMes(empresaId!);
      const limite = getFeedbackLimit(plan);
      if (usadas >= limite) {
        throw new ReviewQuotaError(
          `Limite mensal de avaliações atingido (${limite}). Faça upgrade do plano.`
        );
      }
    }
  }

  const flags = isTest
    ? ['teste_painel']
    : softFraudFlags({ name: name || 'Anônimo', comment, rating });

  let aiReply: string | null = null;
  let aiTags: string | null = null;
  let aiSkippedQuota = false;

  const planAllowsAi = !isTest && planTemIA(plan) && aiConfigured();
  let useAi = planAllowsAi;

  if (useAi && empresaId) {
    const q = await assertEmpresaTokenQuota(empresaId, plan);
    if (!q.ok) {
      useAi = false;
      aiSkippedQuota = true;
    }
  }

  const useAiSentiment = useAi && Boolean(comment?.trim());
  const sentiment = await analisarSentimento(
    rating,
    comment || '',
    useAiSentiment,
    empresaId
  );

  if (useAi && rating <= 3 && comment) {
    try {
      const [resposta, tags] = await Promise.all([
        gerarRespostaReview(
          name || 'Anônimo',
          rating,
          comment,
          nomeEmpresa,
          undefined,
          empresaId,
          locale
        ),
        gerarTagsSemanticas(rating, comment, empresaId, locale),
      ]);
      aiReply = resposta || null;
      aiTags = tags?.length ? JSON.stringify(tags) : null;
    } catch (e: any) {
      console.warn('IA review (não bloqueia envio):', e?.message || e);
    }
  } else if (!isTest && rating <= 3 && comment) {
    aiTags = JSON.stringify(rating <= 2 ? ['#NegativeExperience'] : ['#Neutral']);
  }

  const baseParams = [
    empresaId,
    name || 'Anônimo',
    rating,
    comment || null,
    aiReply,
    aiTags,
  ];

  let result: any;
  const attempts: { sql: string; params: any[] }[] = [
    {
      sql: `INSERT INTO reviews (
        empresa_id, name, rating, comment, ai_reply, ai_tags,
        is_test, ip_hash, fraud_flags, origin,
        sentiment, sentiment_score, sentiment_source, client_whatsapp, locale
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        ...baseParams,
        isTest ? 1 : 0,
        isTest ? null : ipHash,
        flags.length ? JSON.stringify(flags) : null,
        isTest ? 'painel_teste' : 'publico',
        sentiment.label,
        sentiment.score,
        sentiment.source,
        clientWpp,
        locale,
      ],
    },
    {
      sql: `INSERT INTO reviews (
        empresa_id, name, rating, comment, ai_reply, ai_tags,
        is_test, ip_hash, fraud_flags, origin, client_whatsapp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        ...baseParams,
        isTest ? 1 : 0,
        isTest ? null : ipHash,
        flags.length ? JSON.stringify(flags) : null,
        isTest ? 'painel_teste' : 'publico',
        clientWpp,
      ],
    },
    {
      sql: `INSERT INTO reviews (empresa_id, name, rating, comment, ai_reply, ai_tags)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: baseParams,
    },
  ];

  let lastErr: any;
  for (const a of attempts) {
    try {
      result = await db.run(a.sql, a.params);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) {
    console.error('INSERT review falhou:', lastErr?.message || lastErr);
    throw lastErr;
  }

  if (!isTest && empresaId && rating <= 3) {
    notifyCrisisReview(db, {
      empresaId,
      rating,
      name: name || undefined,
      slugOrId,
    }).catch((e) => console.warn('push crise:', e?.message || e));

    emailDaEmpresa(db, empresaId)
      .then(async (email) => {
        if (!email) return;
        await notificarCriticaPrivada({
          email,
          nomeEmpresa: nomeEmpresa || 'Empresa',
          nomeCliente: name || undefined,
          rating,
          comment,
          aiReply,
          clientWhatsapp: clientWpp,
          slug: slugOrId,
          empresaId,
        });

        try {
          const ha24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const row = await db.get(
            `SELECT COUNT(*) as n FROM reviews
             WHERE empresa_id = ? AND rating <= 2 AND COALESCE(is_test,0) = 0 AND createdAt >= ?`,
            [empresaId, ha24h]
          );
          const n = Number(row?.n || 0);
          if (n >= 3) {
            await notificarAlertaCrise({
              email,
              nomeEmpresa: nomeEmpresa || 'Empresa',
              quantidade: n,
              slug: slugOrId,
              empresaId,
            });
          }
        } catch {
          /* não bloqueia */
        }
      })
      .catch((e) => console.warn('e-mail crítica:', e?.message || e));
  }

  return {
    success: true,
    id: result?.lastID,
    ai: Boolean(aiReply),
    is_test: isTest,
    sentiment: sentiment.label,
    ai_skipped_quota: aiSkippedQuota,
    locale,
  };
}

export async function listarReviews(ref: string, db: Database = getDb()) {
  const emp = await findEmpresa(ref);
  if (!emp) throw new ReviewNotFoundError();
  await ensureReviewFraudColumns(db);
  await ensureSentimentColumns(db);
  try {
    return await db.all(
      `SELECT * FROM reviews WHERE empresa_id = ? ORDER BY id DESC LIMIT 100`,
      [emp.id]
    );
  } catch {
    return [];
  }
}
