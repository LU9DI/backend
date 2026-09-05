/**
 * Regras de negócio de avaliações (reviews).
 */
import type { Database } from 'sqlite';
import { getDb, findEmpresa } from '../lib/db.js';
import { gerarRespostaReview, gerarTagsSemanticas, aiConfigured } from '../groqService.js';
import { planTemIA, getFeedbackLimit, contarReviewsMes } from '../lib/quota.js';

export type ReviewInput = {
  name?: string;
  comment?: string;
  rating: number;
  empresa_id?: string;
  empresa_ref?: string;
};

export type ReviewResult = {
  success: true;
  id: number | undefined;
  ai: boolean;
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

export async function criarReview(
  input: ReviewInput,
  db: Database = getDb()
): Promise<ReviewResult> {
  const name = input.name ? String(input.name) : '';
  const comment = input.comment ? String(input.comment) : '';
  const rating = Number(input.rating);
  const empresaRef = String(input.empresa_id || input.empresa_ref || '').slice(0, 100);

  let empresaId: string | null = null;
  let nomeEmpresa: string | undefined;
  let plan = 'trial';

  if (empresaRef) {
    const emp = await findEmpresa(empresaRef);
    if (!emp) throw new ReviewNotFoundError();
    empresaId = emp.id;
    nomeEmpresa = emp.nome_empresa;
    plan = String(emp.plan || emp.status || 'trial').toLowerCase();

    const usadas = await contarReviewsMes(empresaId);
    const limite = getFeedbackLimit(plan);
    if (usadas >= limite) {
      throw new ReviewQuotaError(
        `Limite mensal de avaliações atingido (${limite}). Faça upgrade do plano.`
      );
    }
  }

  let aiReply: string | null = null;
  let aiTags: string | null = null;

  if (rating <= 3 && comment && planTemIA(plan) && aiConfigured()) {
    try {
      const [resposta, tags] = await Promise.all([
        gerarRespostaReview(name || 'Anônimo', rating, comment, nomeEmpresa),
        gerarTagsSemanticas(rating, comment),
      ]);
      aiReply = resposta || null;
      aiTags = tags?.length ? JSON.stringify(tags) : null;
    } catch (e: any) {
      console.warn('IA review (não bloqueia envio):', e?.message || e);
    }
  } else if (rating <= 3 && comment) {
    aiTags = JSON.stringify(rating <= 2 ? ['#ExperienciaNegativa'] : ['#Neutro']);
  }

  const result = await db.run(
    `INSERT INTO reviews (empresa_id, name, rating, comment, ai_reply, ai_tags)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [empresaId, name || 'Anônimo', rating, comment || null, aiReply, aiTags]
  );

  return {
    success: true,
    id: result.lastID,
    ai: Boolean(aiReply),
  };
}

export async function listarReviews(ref: string, db: Database = getDb()) {
  const emp = await findEmpresa(ref);
  if (!emp) throw new ReviewNotFoundError();
  return db.all(
    `SELECT id, name, rating, comment, ai_reply, ai_tags, createdAt
     FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC LIMIT 100`,
    [emp.id]
  );
}
