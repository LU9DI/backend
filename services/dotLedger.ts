/**
 * Ledger durável do orçamento do Filtra Dot.
 *
 * Substitui a reserva em memória (`dotTokenReservations` em `routes/dotRoutes.ts`
 * e `aiReservations` em `lib/quota.ts`) por reservas persistidas e vinculadas à
 * linha de consumo real em `ai_usage`.
 *
 * Garantias cobertas pelos testes em `tests/dotLedger.test.ts` e
 * `tests/dotLedger.pg.test.ts` (a suíte PostgreSQL precisa ser executada em
 * uma instância descartável para validar concorrência entre processos):
 *
 *  1. Reserva antes da chamada ao provedor — a resposta nunca inicia quando o
 *     orçamento restante é menor que o teto da própria resposta.
 *  2. Reserva vinculada ao consumo: `finalize` bloqueia a linha no PostgreSQL
 *     (`FOR UPDATE`) e grava o consumo real em
 *     `ai_usage` (`feature='dot'`) e marca a reserva como `settled` na MESMA
 *     transação. Um retry não duplica consumo (`ai_usage_id` único).
 *  3. Resultado ambíguo do provedor NUNCA libera a reserva: a reserva fica
 *     `pending` com `ambiguous=1` e continua comprometendo o orçamento até a
 *     reconciliação (que exige decisão explícita: `release` ou `settle`).
 *  4. Reserva atômica: `reserve` usa advisory transaction lock por empresa/feature
 *     no PostgreSQL e calcula uso + reservas dentro da mesma transação.
 *  5. Expiração idempotente: `sweep` só mexe em reservas `pending` nunca
 *     enviadas e nunca sobrescreve uma reserva que `finalize` esteja
 *     finalizando — a transição é um `UPDATE ... WHERE status='pending'`, e
 *     quem perde a corrida lê o estado final em vez de recriá-lo. Reservas
 *     comprovadamente enviadas (`markDotReservationSent`) jamais expiram:
 *     vencidas sem finalização, viram `ambiguous` (não consumíveis,
 *     comprometidas até reconciliação).
 *  6. Tokens reais e estimados são campos distintos (`tokens_real`,
 *     `tokens_estimated`) e a cota consome a soma (`tokens` = in+out quando o
 *     provedor informa; senão o total reportado; senão a estimativa). O teto
 *     da reserva NUNCA é debitado como consumo.
 *  7. A contabilidade do fluxo do DOT é ÚNICA e vive aqui (`ai_usage`, uma
 *     linha por reserva) — `callAI` não grava uso quando o Dot reserva.
 *
 * O ledger nunca decide política de plano: ele recebe o limite (de
 * `lib/quota.ts`) e aplica a mesma regra que a rota usava, agora com estado
 * durável.
 */
import { getDb, withDbTransaction, dbEngine } from '../lib/db.js';
import { getFeatureTokenLimit, getTokenLimit } from '../lib/quota.js';
import { normalizePlan } from '../lib/plans.js';
import { incCounter } from '../lib/metrics.js';
import { logEvent } from '../lib/observability.js';

/**
 * Plano canônico para cota (#141): só `rei`/`corporativo` têm orçamento de Dot.
 * Plano ausente/desconhecido vira string vazia — SEM fallback para Rei.
 */
function normalizePlanForQuota(plan: string | null | undefined): string {
  return normalizePlan(plan) ?? '';
}

export type DotReservationStatus = 'pending' | 'settled' | 'released' | 'expired';

export type DotReservation = {
  id: number;
  empresa_id: string;
  feature: string;
  plan: string;
  status: DotReservationStatus;
  tokens_reserved: number;
  tokens_real: number | null;
  tokens_estimated: number | null;
  provider: string | null;
  ambiguous: number;
  ambiguous_reason: string | null;
  ai_usage_id: number | null;
  execution_ref: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  settled_at: string | null;
};

export type DotBudgetSnapshot = {
  empresa_id: string;
  plan: string;
  feature: string;
  limit: number;
  feedback_limit: number;
  used: number;
  reserved: number;
  ambiguous: number;
  remaining: number;
  response_limit: number;
  warning: boolean;
  exhausted: boolean;
  percent: number;
  pending_reservations: number;
};

export const DOT_FEATURE = 'dot';
const WARNING_THRESHOLD = 0.8;
const DEFAULT_TTL_MS = Math.max(5_000, Number(process.env.DOT_TOKEN_RESERVATION_TTL_MS || 30_000));
const DEFAULT_RESPONSE_LIMIT = Math.max(300, Number(process.env.DOT_DEFAULT_RESPONSE_TOKENS || 900));

const RESPONSE_TOKEN_LIMITS: Record<string, number> = {
  rei: Math.max(300, Number(process.env.DOT_REI_RESPONSE_TOKENS || 1800)),
  corporativo: Math.max(300, Number(process.env.DOT_CORPORATIVO_RESPONSE_TOKENS || 1200)),
};


let schemaReady = false;

function nowIso(): string {
  return new Date().toISOString();
}

function int(value: unknown): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function dotResponseTokenLimit(plan?: string | null): number {
  // Fail-closed (#141): plano nao identificado/fora de Rei|Corporativo = teto 0.
  const key = normalizePlan(plan);
  if (key !== 'rei' && key !== 'corporativo') return 0;
  return RESPONSE_TOKEN_LIMITS[key] || 0;
}

export function dotReservationTtlMs(): number {
  return DEFAULT_TTL_MS;
}


/**
 * Lock transacional comum a todas as transições que alteram o compromisso do
 * orçamento da empresa. A chave é por empresa (não por feature) para manter
 * snapshots consistentes mesmo quando duas features compartilham ai_usage.
 */
async function lockDotBudget(tx: any, empresaId: string): Promise<void> {
  if (dbEngine() !== 'postgres') return; // SQLite: withDbTransaction serializa o handle.
  await tx.get(
    'SELECT pg_advisory_xact_lock(hashtextextended(?, 0)) AS locked',
    [`filtra-dot-budget:${empresaId}`],
  );
}

/**
 * Compatibilidade de assinatura (testes e worker PG). A DDL do ledger vive na
 * migração central (`lib/migrations.ts` -> `migrateDotBudgetLedger`, executada
 * por `initDB`). Esta função apenas VALIDA o schema — nunca cria tabela/coluna,
 * portanto NÃO é uma segunda fonte de schema.
 */
export async function ensureDotLedgerSchema(): Promise<void> {
  await assertDotLedgerSchema();
}

/** Verificação usada em caminhos de requisição (sem DDL). */
export async function assertDotLedgerSchema(): Promise<void> {
  if (schemaReady) return;
  const db = getDb();
  const cols = await db.all('PRAGMA table_info(dot_budget_reservations)');
  if (!cols || cols.length === 0) {
    throw new Error('dot_budget_reservations ausente: migração central não executada.');
  }
  const names = new Set(cols.map((c: any) => String(c?.name || '').toLowerCase()));
  const missing = ['id', 'empresa_id', 'status', 'tokens_reserved', 'expires_at', 'sent_at'].filter((c) => !names.has(c));
  if (missing.length > 0) {
    throw new Error(
      `dot_budget_reservations incompleta (faltam ${missing.join(', ')}): migração central desatualizada.`,
    );
  }
  schemaReady = true;
}

function monthBounds(mes?: string): { start: string; end: string } {
  const base = mes || new Date().toISOString().slice(0, 7);
  const [y, m] = base.split('-').map(Number);
  const start = `${base}-01T00:00:00.000Z`;
  const end = new Date(Date.UTC(y, m, 1)).toISOString();
  return { start, end };
}

/**
 * Tokens do Dot já consumidos no mês corrente.
 *
 * Em PostgreSQL a comparação é de timestamp; em SQLite a coluna é texto e o
 * formato gravado é `YYYY-MM-DD HH:MM:SS`, por isso a comparação textual com
 * substr (mesma semântica usada em `lib/quota.ts`).
 */
async function usedThisMonth(db: any, empresaId: string, feature: string): Promise<number> {
  const mes = new Date().toISOString().slice(0, 7);
  if (dbEngine() === 'postgres') {
    const { start, end } = monthBounds(mes);
    const row = await db.get(
      `SELECT COALESCE(SUM(tokens),0) AS t FROM ai_usage
        WHERE empresa_id = ? AND feature = ? AND criado_em >= ? AND criado_em < ?`,
      [empresaId, feature, start, end],
    );
    return int(row?.t);
  }
  const row = await db.get(
    `SELECT COALESCE(SUM(tokens),0) AS t FROM ai_usage
      WHERE empresa_id = ? AND feature = ? AND substr(criado_em, 1, 7) = ?`,
    [empresaId, feature, mes],
  );
  return int(row?.t);
}

/**
 * Tokens comprometidos por reservas abertas.
 *
 * - `pending` com `expires_at` futuro: vale `tokens_reserved` (pior caso).
 * - `pending` ambíguo: continua valendo `tokens_reserved` sem prazo. Só
 *   reconciliação explícita pode liberar ou liquidar uma chamada possivelmente
 *   cobrada pelo provedor.
 * - `pending` que SAIU para o provedor (`sent_at`): vale `tokens_reserved`
 *   mesmo vencida, até finalizar ou ser reconciliada.
 * - `pending` nunca enviada e vencida: ainda não foi varrida pelo sweep; vale 0
 *   aqui (o sweep logo o marca `expired`), mas `getDotBudgetSnapshot` chama o
 *   sweep antes de calcular para manter a leitura consistente.
 */
async function reservedTokens(db: any, empresaId: string, feature: string, now = new Date()): Promise<{ total: number; ambiguous: number; pending: number }> {
  const rows = await db.all(
    `SELECT tokens_reserved, tokens_estimated, ambiguous, expires_at, sent_at FROM dot_budget_reservations
      WHERE empresa_id = ? AND feature = ? AND status = 'pending'`,
    [empresaId, feature],
  );
  let total = 0;
  let ambiguousTotal = 0;
  let pending = 0;
  for (const row of rows || []) {
    const reserved = int(row.tokens_reserved) || int(row.tokens_estimated);
    const expiresAt = Date.parse(String(row.expires_at || ''));
    const isAmbiguous = Number(row.ambiguous) === 1;
    // Uma chamada ambígua pode ter sido cobrada. TTL não é evidência de
    // ausência de cobrança: mantém o compromisso até reconciliação manual.
    const isSent = row.sent_at !== null && row.sent_at !== undefined;
    // Uma reserva ENVIA ao provedor nunca é liberada pelo relógio: a resposta
    // pode consumir (e ser cobrada) bem depois do TTL. Só finalize/reconciliação
    // encerra o compromisso. Uma reserva que não saiu e venceu está livre.
    const active = isAmbiguous || isSent || !Number.isFinite(expiresAt) || now.getTime() < expiresAt;
    if (!active) continue;
    pending += 1;
    total += reserved;
    if (isAmbiguous) ambiguousTotal += reserved;
  }
  return { total, ambiguous: ambiguousTotal, pending };
}

export type ReserveResult = {
  ok: boolean;
  reservation?: DotReservation;
  snapshot: DotBudgetSnapshot;
  code?: 'DOT_TOKEN_LIMIT' | 'DOT_BUDGET_UNAVAILABLE';
  /** `true` quando a leitura/persistência falhou (orçamento desconhecido). */
  unavailable?: boolean;
};

/**
 * Snapshot do orçamento do Dot (uso: status, chat, painel).
 *
 * Falha fechada: se a leitura da cota falhar, `remaining` é 0 e
 * `exhausted` é true — o chamador nunca libera tokens porque o controle
 * está indisponível.
 */
export async function getDotBudgetSnapshot(
  empresaId: string | null | undefined,
  plan: string | null | undefined,
  opts: { feature?: string; responseLimit?: number; runSweep?: boolean } = {},
): Promise<DotBudgetSnapshot> {
  const feature = String(opts.feature || DOT_FEATURE).toLowerCase();
  const normalizedPlan = normalizePlanForQuota(plan);
  const limit = getFeatureTokenLimit(normalizedPlan, feature);
  const feedbackLimit = getTokenLimit(normalizedPlan);
  const responseLimit = int(opts.responseLimit) || dotResponseTokenLimit(normalizedPlan);

  const base: DotBudgetSnapshot = {
    empresa_id: String(empresaId || ''),
    plan: normalizedPlan,
    feature,
    limit,
    feedback_limit: feedbackLimit,
    used: 0,
    reserved: 0,
    ambiguous: 0,
    remaining: 0,
    response_limit: responseLimit,
    warning: false,
    exhausted: limit <= 0,
    percent: 0,
    pending_reservations: 0,
  };

  if (!empresaId || limit <= 0) return base;

  try {
    const db = getDb();
    await assertDotLedgerSchema();
    if (opts.runSweep !== false) await sweepExpiredDotReservations({ empresaId });
    const used = await usedThisMonth(db, empresaId, feature);
    const { total: reserved, ambiguous, pending } = await reservedTokens(db, empresaId, feature);
    const remaining = Math.max(0, limit - used - reserved);
    const percent = limit > 0 ? (used + reserved) / limit : 1;
    return {
      ...base,
      used,
      reserved,
      ambiguous,
      remaining,
      pending_reservations: pending,
      percent,
      warning: percent >= WARNING_THRESHOLD && remaining > 0,
      exhausted: remaining <= 0,
    };
  } catch (error: any) {
    console.error('[dot-ledger] falha ao ler o orçamento do Dot:', error?.message || error);
    return { ...base, remaining: 0, exhausted: true, percent: 1 };
  }
}

/**
 * Reserva o teto de saída de UMA resposta.
 *
 * Regra preservada de `checkDotTokenBudget`: a resposta só inicia quando
 * `limite - usado - reservado >= teto da resposta`. A diferença é que a reserva
 * é persistida (sobrevive a restart e é vista por outra instância).
 */
export async function reserveDotExecution(params: {
  empresaId: string;
  plan?: string | null;
  responseLimit?: number;
  /** Estimativa conservadora dos tokens de entrada (system + contexto + histórico + mensagem). */
  inputTokensEstimate?: number;
  executionRef?: string | null;
  feature?: string;
}): Promise<ReserveResult> {
  const empresaId = String(params.empresaId || '').trim();
  const feature = String(params.feature || DOT_FEATURE).toLowerCase();
  const normalizedPlan = normalizePlanForQuota(params.plan);
  const limit = getFeatureTokenLimit(normalizedPlan, feature);
  const feedbackLimit = getTokenLimit(normalizedPlan);
  const responseLimit = int(params.responseLimit) || dotResponseTokenLimit(normalizedPlan);
  // A reserva cobre o pior caso da chamada inteira: prompt de entrada + teto de saída.
  const inputTokensEstimate = int(params.inputTokensEstimate);
  const needed = responseLimit + inputTokensEstimate;
  const base: DotBudgetSnapshot = {
    empresa_id: empresaId, plan: normalizedPlan, feature, limit,
    feedback_limit: feedbackLimit, used: 0, reserved: 0, ambiguous: 0,
    remaining: 0, response_limit: responseLimit, warning: false,
    exhausted: limit <= 0, percent: 0, pending_reservations: 0,
  };
  if (!empresaId || limit <= 0) {
    return { ok: false, snapshot: { ...base, exhausted: true }, code: 'DOT_BUDGET_UNAVAILABLE' };
  }

  try {
    await assertDotLedgerSchema();
    // Expira apenas reservas não ambíguas vencidas. Reservas ambíguas nunca
    // são liberadas pelo relógio.
    await sweepExpiredDotReservations({ empresaId });
    const db = getDb();
    return await withDbTransaction(async (tx) => {
      // Serializa reservas e liquidações da empresa entre processos e pools.
      // O lock é transacional e liberado automaticamente em COMMIT/ROLLBACK.
      await lockDotBudget(tx, empresaId);

      const used = await usedThisMonth(tx, empresaId, feature);
      const { total: reserved, ambiguous, pending } = await reservedTokens(tx, empresaId, feature);
      const remaining = Math.max(0, limit - used - reserved);
      const percent = limit > 0 ? (used + reserved) / limit : 1;
      const snapshot: DotBudgetSnapshot = {
        ...base, used, reserved, ambiguous, remaining,
        pending_reservations: pending, percent,
        warning: percent >= WARNING_THRESHOLD && remaining > 0,
        exhausted: remaining <= 0,
      };
      if (remaining < needed) {
        return { ok: false, snapshot, code: 'DOT_TOKEN_LIMIT' };
      }

      const now = new Date();
      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + DEFAULT_TTL_MS).toISOString();
      const inserted = await tx.run(
        `INSERT INTO dot_budget_reservations
           (empresa_id, feature, plan, status, tokens_reserved, ambiguous, execution_ref, created_at, updated_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        [empresaId, feature, normalizedPlan, 'pending', needed, 0, params.executionRef ?? null, createdAt, createdAt, expiresAt],
      );
      const id = int(inserted?.lastID);
      const reservationRow = id
        ? await tx.get('SELECT * FROM dot_budget_reservations WHERE id = ? AND empresa_id = ? LIMIT 1', [id, empresaId])
        : null;
      if (!reservationRow) throw new Error('reserva inserida sem ID recuperável');
      incCounter('dot_ledger_reserved');
      return { ok: true, reservation: reservationRow as DotReservation, snapshot };
    });
  } catch (error: any) {
    incCounter('dot_ledger_reserve_error');
    logEvent('error', 'dot_ledger_reserve_error', {
      empresa_id: empresaId,
      feature,
      detail: String(error?.message || error),
    });
    console.error('[dot-ledger] falha ao reservar orçamento:', error?.message || error);
    // ORÇAMENTO DESCONHECIDO nunca vira orçamento disponível, e também não é
    // "limite atingido": são causas distintas e o cliente precisa distingui-las.
    //   DOT_BUDGET_UNAVAILABLE → falha de leitura/persistência (indisponível)
    //   DOT_TOKEN_LIMIT        → orçamento realmente esgotado
    // Sem este marcador, um erro de banco era devolvido como 429 "orçamento
    // esgotado" (o teste fail-closed detectou exatamente isso).
    return {
      ok: false,
      snapshot: { ...base, remaining: 0, exhausted: true, percent: 1 },
      code: 'DOT_BUDGET_UNAVAILABLE',
      unavailable: true,
    };
  }
}

export async function getDotReservation(empresaId: string, id: number): Promise<DotReservation | null> {
  await assertDotLedgerSchema();
  const row = await getDb().get(
    'SELECT * FROM dot_budget_reservations WHERE id = ? AND empresa_id = ? LIMIT 1',
    [int(id), String(empresaId)],
  );
  return (row as DotReservation) || null;
}

/**
 * Marca a reserva como comprovadamente ENVIADA ao provedor.
 *
 * Chamada ANTES da requisição HTTP: a partir dela o sweep nunca libera o
 * orçamento desta reserva sem finalização. A marca é idempotente e
 * transacional (mesmo lock da empresa): um processo que cai entre o envio e
 * a finalização deixa a reserva `pending` com `sent_at` gravado — o sweep
 * posterior a converte em `ambiguous` (comprometida até reconciliação).
 */
export async function markDotReservationSent(params: {
  empresaId: string;
  reservationId: number;
}): Promise<{ ok: boolean; reservation: DotReservation | null }> {
  const empresaId = String(params.empresaId || '').trim();
  const id = int(params.reservationId);
  if (!empresaId || !id) return { ok: false, reservation: null };
  await assertDotLedgerSchema();
  try {
    return await withDbTransaction(async (tx) => {
      await lockDotBudget(tx, empresaId);
      const now = nowIso();
      const updated = await tx.run(
        `UPDATE dot_budget_reservations
            SET sent_at = COALESCE(sent_at, ?), updated_at = ?
          WHERE id = ? AND empresa_id = ? AND status = 'pending' AND sent_at IS NULL`,
        [now, now, id, empresaId],
      );
      const row = await tx.get(
        'SELECT * FROM dot_budget_reservations WHERE id = ? AND empresa_id = ?',
        [id, empresaId],
      );
      // A existência da linha não prova que a transição ocorreu: ela pode
      // ter sido expirada/liberada entre reserve e mark. Só autoriza o envio
      // quando este UPDATE atingiu exatamente uma reserva ainda pending.
      const marked = Boolean(updated && updated.changes === 1 && row
        && String(row.status) === 'pending' && row.sent_at);
      return { ok: marked, reservation: (row as DotReservation) || null };
    });
  } catch (error: any) {
    console.error('[dot-ledger] falha ao marcar reserva como enviada:', error?.message || error);
    return { ok: false, reservation: null };
  }
}

/**
 * Converte a estimativa provisória em consumo real.
 *
 * - Grava `ai_usage` (consumo real, `feature`) e fecha a reserva como
 *   `settled` na MESMA transação.
 * - Idempotente: reserva já `settled` devolve o estado final sem inserir
 *   consumo novo; retry nunca duplica `ai_usage`.
 * - Consumo cobrado: o REAL (`tokens`) quando o provedor informou, senão a
 *   soma de `inputTokens` + `outputTokens`, senão a estimativa explícita. O
 *   teto da reserva NUNCA é debitado como consumo.
 * - Tokens de entrada/saída ficam em `ai_usage.tokens_input` /
 *   `.tokens_output`; a cota continua somando `tokens`.
 */
export async function finalizeDotReservation(params: {
  empresaId: string;
  reservationId: number;
  tokens?: number | null;
  estimatedTokens?: number | null;
  /** Tokens de entrada/saída informados pelo provedor (quando existem). */
  inputTokens?: number | null;
  outputTokens?: number | null;
  provider?: string | null;
  tipo?: string;
  ambiguous?: boolean;
  ambiguousReason?: string | null;
}): Promise<{ ok: boolean; reservation: DotReservation | null; duplicate?: boolean; reason?: string }> {
  const empresaId = String(params.empresaId || '').trim();
  const id = int(params.reservationId);
  if (!empresaId || !id) return { ok: false, reservation: null, reason: 'reserva inválida' };
  await assertDotLedgerSchema();

  const toNonNegative = (value: number | null | undefined): number | null =>
    value === null || value === undefined ? null : Math.max(0, Math.round(Number(value) || 0));

  const tokensEstimated = toNonNegative(params.estimatedTokens);
  const tokensInput = toNonNegative(params.inputTokens);
  const tokensOutput = toNonNegative(params.outputTokens);
  let tokensReal = toNonNegative(params.tokens);
  if (tokensReal === null && (tokensInput !== null || tokensOutput !== null)) {
    tokensReal = (tokensInput ?? 0) + (tokensOutput ?? 0);
  }
  // Consumo registrado: o real quando existe; senão a estimativa explícita.
  // O teto da reserva jamais é debitado — ele só limita a admissão.
  const chargedTokens = tokensReal ?? tokensEstimated ?? 0;

  try {
    return await withDbTransaction(async (tx) => {
      // Mesmo lock de reserve: impede que um snapshot leia ai_usage antes do
      // COMMIT e reservas pendentes depois do COMMIT (subcontagem transitória).
      await lockDotBudget(tx, empresaId);
      // SELECT FOR UPDATE impede duas instâncias de inserir ai_usage para a
      // mesma reserva. SQLite não oferece FOR UPDATE e já serializa suas
      // transações por withDbTransaction.
      const lockSuffix = dbEngine() === 'postgres' ? ' FOR UPDATE' : '';
      const current = await tx.get(
        `SELECT * FROM dot_budget_reservations WHERE id = ? AND empresa_id = ? LIMIT 1${lockSuffix}`,
        [id, empresaId],
      );
      if (!current) return { ok: false, reservation: null, reason: 'reserva não encontrada' };
      const status = String(current.status);
      if (status === 'settled') {
        // Retry: o consumo já foi registrado por esta reserva.
        incCounter('dot_ledger_settled_duplicate');
        return { ok: true, reservation: current as DotReservation, duplicate: true };
      }
      if (status !== 'pending') {
        return { ok: false, reservation: current as DotReservation, reason: `reserva já ${status}` };
      }

      // Resultado ambíguo: NÃO libera, NÃO registra consumo definitivo.
      // A reserva continua comprometendo o orçamento até a reconciliação.
      if (params.ambiguous) {
        await tx.run(
          `UPDATE dot_budget_reservations
              SET ambiguous = 1, ambiguous_reason = ?, tokens_estimated = COALESCE(?, tokens_estimated),
                  provider = COALESCE(?, provider), updated_at = ?
            WHERE id = ? AND empresa_id = ? AND status = 'pending'`,
          [
            String(params.ambiguousReason || 'resultado ambíguo do provedor').slice(0, 500),
            tokensEstimated,
            params.provider ? String(params.provider).slice(0, 20) : null,
            nowIso(),
            id,
            empresaId,
          ],
        );
        const updated = await tx.get('SELECT * FROM dot_budget_reservations WHERE id = ? AND empresa_id = ?', [id, empresaId]);
        incCounter('dot_ledger_ambiguous');
        logEvent('warn', 'dot_ledger_ambiguous', {
          empresa_id: empresaId,
          reservation_id: id,
          reason: String(params.ambiguousReason || 'resultado ambíguo do provedor'),
        });
        return { ok: true, reservation: updated as DotReservation, reason: 'resultado ambíguo mantém a reserva aberta' };
      }

      let aiUsageId: number | null = null;
      if (chargedTokens > 0) {
        const inserted = await tx.run(
          `INSERT INTO ai_usage (empresa_id, tipo, tokens, provider, feature, tokens_input, tokens_output, criado_em)
           VALUES (?,?,?,?,?,?,?,datetime('now')) RETURNING id`,
          [
            empresaId,
            String(params.tipo || 'filtra_dot_chat').slice(0, 40),
            chargedTokens,
            params.provider ? String(params.provider).slice(0, 20) : null,
            DOT_FEATURE,
            tokensInput,
            tokensOutput,
          ],
        );
        aiUsageId = int(inserted?.lastID) || null;
      }

      const settledAt = nowIso();
      const updatedRow = await tx.run(
        `UPDATE dot_budget_reservations
            SET status = 'settled', tokens_real = ?, tokens_estimated = COALESCE(?, tokens_estimated),
                provider = COALESCE(?, provider), ai_usage_id = ?, settled_at = ?, updated_at = ?
          WHERE id = ? AND empresa_id = ? AND status = 'pending'`,
        [
          tokensReal,
          tokensEstimated,
          params.provider ? String(params.provider).slice(0, 20) : null,
          aiUsageId,
          settledAt,
          settledAt,
          id,
          empresaId,
        ],
      );
      if (!updatedRow || updatedRow.changes !== 1) {
        // O UPDATE pode não atingir a linha se o estado mudou entre a leitura
        // com FOR UPDATE e a escrita. Só é seguro declarar duplicidade quando
        // o estado persistido é 'settled'; qualquer outro estado (expired,
        // released, pending ou inexistente) NÃO é sucesso: o throw desfaz a
        // transação — inclusive o ai_usage já inserido — para não deixar
        // consumo órfão nem duplicado.
        const final = await tx.get('SELECT * FROM dot_budget_reservations WHERE id = ? AND empresa_id = ?', [id, empresaId]);
        if (final && String(final.status) === 'settled') {
          return { ok: true, reservation: final as DotReservation, duplicate: true };
        }
        throw new Error(`reserva em estado '${final ? String(final.status) : 'inexistente'}' — liquidação não aplicada`);
      }
      const final = await tx.get('SELECT * FROM dot_budget_reservations WHERE id = ? AND empresa_id = ?', [id, empresaId]);
      incCounter('dot_ledger_settled');
      logEvent('info', 'dot_ledger_settled', {
        empresa_id: empresaId,
        reservation_id: id,
        tokens_charged: chargedTokens,
        provider: params.provider ?? null,
        tipo: params.tipo || 'filtra_dot_chat',
      });
      return { ok: true, reservation: final as DotReservation };
    });
  } catch (error: any) {
    incCounter('dot_ledger_finalize_error');
    logEvent('error', 'dot_ledger_finalize_error', {
      empresa_id: empresaId,
      reservation_id: id,
      detail: String(error?.message || error),
    });
    console.error('[dot-ledger] falha ao finalizar reserva:', error?.message || error);
    return { ok: false, reservation: null, reason: String(error?.message || error) };
  }
}

/**
 * Libera a reserva — SOMENTE quando houver comprovação de que a solicitação
 * não foi enviada ao provedor (ex.: falta de provedor configurado, rejeição
 * antes do envio). Chamadas com `provenNotSent=false` são recusadas: a
 * reserva continua comprometendo o orçamento até reconciliação segura.
 */
export async function releaseDotReservation(params: {
  empresaId: string;
  reservationId: number;
  reason?: string;
  provenNotSent: boolean;
}): Promise<{ ok: boolean; reservation: DotReservation | null; reason?: string }> {
  const empresaId = String(params.empresaId || '').trim();
  const id = int(params.reservationId);
  if (!empresaId || !id) return { ok: false, reservation: null, reason: 'reserva inválida' };
  await assertDotLedgerSchema();
  if (!params.provenNotSent) {
    incCounter('dot_ledger_release_refused');
    logEvent('warn', 'dot_ledger_release_refused', { empresa_id: empresaId, reservation_id: id });
    return {
      ok: false,
      reservation: await getDotReservation(empresaId, id),
      reason: 'liberação recusada: a solicitação pode ter sido enviada ao provedor',
    };
  }
  try {
    return await withDbTransaction(async (tx) => {
      await lockDotBudget(tx, empresaId);
      const now = nowIso();
      const updated = await tx.run(
        `UPDATE dot_budget_reservations
            SET status = 'released', tokens_real = 0, updated_at = ?, settled_at = ?
          WHERE id = ? AND empresa_id = ? AND status = 'pending'`,
        [now, now, id, empresaId],
      );
      const final = await tx.get(
        'SELECT * FROM dot_budget_reservations WHERE id = ? AND empresa_id = ?',
        [id, empresaId],
      ) as DotReservation | undefined;
      const released = Boolean(updated && updated.changes === 1) || final?.status === 'released';
      if (released) {
        incCounter('dot_ledger_released');
        logEvent('info', 'dot_ledger_released', {
          empresa_id: empresaId,
          reservation_id: id,
          reason: params.reason ?? null,
        });
      }
      return { ok: released, reservation: final || null };
    });
  } catch (error: any) {
    console.error('[dot-ledger] falha ao liberar reserva:', error?.message || error);
    return { ok: false, reservation: null, reason: String(error?.message || error) };
  }
}

/**
 * Varredura de expiração — idempotente e segura contra concorrência.
 *
 * Dois caminhos, sempre com UPDATE condicional de uma única instrução:
 *
 *  1. **Abandonadas** — `pending` sem marca de envio e vencida → `expired`.
 *     Libera orçamento: nada foi enviado ao provedor.
 *  2. **Enviadas sem finalização** — `pending` com `sent_at`, vencida além da
 *     carência (`DOT_SENT_GRACE_MS`, padrão 10 minutos) → `ambiguous`. NÃO
 *     expira: o consumo é desconhecido e a reserva continua comprometendo o
 *     orçamento até a reconciliação. A carência evita carimbar como ambígua
 *     uma geração ainda em andamento.
 *
 * Reservas ambíguas nunca são expiradas (a plataforma pode ter sido cobrada).
 * A transição é uma única instrução (sem read-modify-write): `finalize`
 * concorrente que já mudou o status para `settled` faz o UPDATE atingir 0
 * linhas, e nada é sobrescrito.
 */
export async function sweepExpiredDotReservations(opts: { empresaId?: string; limit?: number } = {}): Promise<{ expired: number; ambiguous_held: number; ambiguous_marked: number }> {
  await assertDotLedgerSchema();
  const db = getDb();
  const now = nowIso();
  const max = Math.min(500, Math.max(1, int(opts.limit) || 100));
  const graceMs = Math.max(0, Number(process.env.DOT_SENT_GRACE_MS || 10 * 60_000));
  const graceCutoff = new Date(Date.now() - graceMs).toISOString();
  // Params comuns do escopo de empresa (sempre o MESMO índice de posição).
  const scopeEmpresa = opts.empresaId ? String(opts.empresaId) : null;
  const scope = scopeEmpresa ? ' AND empresa_id = ?' : '';
  const scopeParams = scopeEmpresa ? [scopeEmpresa] : [];

  const heldParams = scopeEmpresa ? [now, scopeEmpresa] : [now];
  try {
    const expired = await db.run(
      // O WHERE externo repete os predicados de estado: sob READ COMMITTED o
      // UPDATE que esperou o lock de um `finalize` reavalia SÓ este WHERE. Sem
      // `status = 'pending'` aqui, uma linha já liquidada seria sobrescrita
      // para 'expired' (consumo órfão).
      `UPDATE dot_budget_reservations
          SET status = 'expired', updated_at = ?
        WHERE status = 'pending' AND ambiguous = 0 AND expires_at <= ? AND sent_at IS NULL${scope}
          AND id IN (
            SELECT id FROM dot_budget_reservations
             WHERE status = 'pending' AND ambiguous = 0 AND expires_at <= ? AND sent_at IS NULL${scope}
             ORDER BY id ASC LIMIT ${max}
          )`,
      [now, now, ...scopeParams, now, ...scopeParams],
    );
    const unterminated = await db.run(
      // Mesmo motivo do UPDATE anterior: o estado precisa ser reconferido no
      // WHERE externo para nunca marcar como ambígua uma reserva já liquidada.
      `UPDATE dot_budget_reservations
          SET ambiguous = 1, ambiguous_reason = ?, updated_at = ?
        WHERE status = 'pending' AND ambiguous = 0 AND sent_at IS NOT NULL
          AND expires_at <= ? AND sent_at <= ?${scope}
          AND id IN (
            SELECT id FROM dot_budget_reservations
             WHERE status = 'pending' AND ambiguous = 0 AND sent_at IS NOT NULL
               AND expires_at <= ? AND sent_at <= ?${scope}
             ORDER BY id ASC LIMIT ${max}
          )`,
      [
        'chamada enviada ao provedor sem finalização — consumo desconhecido',
        now,
        now,
        graceCutoff,
        ...scopeParams,
        now,
        graceCutoff,
        ...scopeParams,
      ],
    );
    const held = await db.get(
      `SELECT COUNT(*) AS c FROM dot_budget_reservations
        WHERE status = 'pending' AND ambiguous = 1 AND expires_at <= ?${scope}`,
      heldParams,
    );
    const expiredCount = Number(expired?.changes || 0);
    const ambiguousMarked = Number(unterminated?.changes || 0);
    const ambiguousHeld = Number(held?.c || 0);
    if (expiredCount || ambiguousMarked) {
      incCounter('dot_ledger_sweep_expired', expiredCount);
      incCounter('dot_ledger_sweep_ambiguous', ambiguousMarked);
      logEvent('warn', 'dot_ledger_sweep', {
        empresa_id: scopeEmpresa,
        expired: expiredCount,
        ambiguous_marked: ambiguousMarked,
        ambiguous_open: ambiguousHeld,
      });
    }
    return {
      expired: expiredCount,
      ambiguous_marked: ambiguousMarked,
      ambiguous_held: ambiguousHeld,
    };
  } catch (error: any) {
    incCounter('dot_ledger_sweep_error');
    logEvent('error', 'dot_ledger_sweep_error', { detail: String(error?.message || error) });
    console.error('[dot-ledger] falha na varredura de reservas:', error?.message || error);
    return { expired: 0, ambiguous_held: 0, ambiguous_marked: 0 };
  }
}

/**
 * Reconciliação de reservas abertas/ambíguas.
 *
 * Nunca decide sozinha: para cada reserva, o operador informa `settle`
 * (com os tokens reais) ou `release` (com comprovação de não envio). Sem
 * decisão, a reserva continua comprometendo o orçamento.
 */
export async function reconcileDotBudget(params: {
  empresaId: string;
  reservationId: number;
  decision: 'settle' | 'release';
  tokens?: number | null;
  reason?: string;
  provider?: string | null;
}): Promise<{ ok: boolean; reservation: DotReservation | null; reason?: string }> {
  const empresaId = String(params.empresaId || '').trim();
  const id = int(params.reservationId);
  if (!empresaId || !id) return { ok: false, reservation: null, reason: 'reserva inválida' };
  if (params.decision !== 'settle' && params.decision !== 'release') {
    return { ok: false, reservation: null, reason: 'decisão de reconciliação inválida' };
  }
  if (params.decision === 'settle' && (!Number.isSafeInteger(Number(params.tokens)) || Number(params.tokens) <= 0)) {
    return { ok: false, reservation: null, reason: 'settle exige tokens reais inteiros maiores que zero' };
  }
  await assertDotLedgerSchema();

  try {
    return await withDbTransaction(async (tx) => {
      // Todas as precondições e a transição são avaliadas sob o mesmo lock.
      // Assim, nenhuma reconciliação pode zerar uma chamada ainda em andamento.
      await lockDotBudget(tx, empresaId);
      const lockSuffix = dbEngine() === 'postgres' ? ' FOR UPDATE' : '';
      const current = await tx.get(
        `SELECT * FROM dot_budget_reservations
          WHERE id = ? AND empresa_id = ? LIMIT 1${lockSuffix}`,
        [id, empresaId],
      ) as DotReservation | undefined;
      if (!current) return { ok: false, reservation: null, reason: 'reserva não encontrada' };
      if (current.status !== 'pending') {
        return { ok: false, reservation: current, reason: 'reserva não está aberta' };
      }
      if (Number(current.ambiguous) !== 1) {
        return { ok: false, reservation: current, reason: 'apenas reservas ambíguas podem ser reconciliadas' };
      }

      const now = nowIso();
      if (params.decision === 'release') {
        if (current.sent_at) {
          return { ok: false, reservation: current, reason: 'reserva enviada ao provedor não pode ser liberada' };
        }
        const updated = await tx.run(
          `UPDATE dot_budget_reservations
              SET status = 'released', tokens_real = 0, updated_at = ?, settled_at = ?
            WHERE id = ? AND empresa_id = ? AND status = 'pending' AND ambiguous = 1 AND sent_at IS NULL`,
          [now, now, id, empresaId],
        );
        if (!updated || updated.changes !== 1) {
          throw new Error('reserva mudou durante a reconciliação; liberação cancelada');
        }
        const final = await tx.get(
          'SELECT * FROM dot_budget_reservations WHERE id = ? AND empresa_id = ?',
          [id, empresaId],
        ) as DotReservation;
        return { ok: true, reservation: final };
      }

      const chargedTokens = Number(params.tokens);
      const inserted = await tx.run(
        `INSERT INTO ai_usage (empresa_id, tipo, tokens, provider, feature, criado_em)
         VALUES (?,?,?,?,?,datetime('now')) RETURNING id`,
        [
          empresaId,
          'filtra_dot_chat_reconciled',
          chargedTokens,
          params.provider ? String(params.provider).slice(0, 20) : null,
          DOT_FEATURE,
        ],
      );
      const aiUsageId = int(inserted?.lastID) || null;
      const updated = await tx.run(
        `UPDATE dot_budget_reservations
            SET status = 'settled', tokens_real = ?, provider = COALESCE(?, provider),
                ai_usage_id = ?, settled_at = ?, updated_at = ?
          WHERE id = ? AND empresa_id = ? AND status = 'pending' AND ambiguous = 1`,
        [
          chargedTokens,
          params.provider ? String(params.provider).slice(0, 20) : null,
          aiUsageId,
          now,
          now,
          id,
          empresaId,
        ],
      );
      if (!updated || updated.changes !== 1) {
        throw new Error('reserva mudou durante a reconciliação; liquidação cancelada');
      }
      const final = await tx.get(
        'SELECT * FROM dot_budget_reservations WHERE id = ? AND empresa_id = ?',
        [id, empresaId],
      ) as DotReservation;
      return { ok: true, reservation: final };
    });
  } catch (error: any) {
    console.error('[dot-ledger] falha ao reconciliar reserva:', error?.message || error);
    return { ok: false, reservation: null, reason: String(error?.message || error) };
  }
}

/** Lista reservas abertas para a reconciliação (painel/admin). */
export async function listOpenDotReservations(empresaId: string): Promise<DotReservation[]> {
  await assertDotLedgerSchema();
  const rows = await getDb().all(
    `SELECT * FROM dot_budget_reservations
      WHERE empresa_id = ? AND status = 'pending'
      ORDER BY id DESC LIMIT 100`,
    [String(empresaId)],
  );
  return (rows || []) as DotReservation[];
}

/**
 * Alerta de orçamento sanitizado.
 *
 * Nunca emite empresa_id, e-mail, telefone, texto de resposta ou token do
 * provedor: apenas números de orçamento e o motivo. A sanitização é
 * obrigatória porque o alerta vai para log/telemetria.
 */
export type DotBudgetAlert = {
  event: 'dot_budget_warning' | 'dot_budget_exhausted' | 'dot_budget_ambiguous';
  severity: 'info' | 'warning' | 'critical';
  percent: number;
  used: number;
  reserved: number;
  limit: number;
  reason: string;
};

const ALERT_REDACTIONS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]'],
  [/\b(?:sk|gsk)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_API_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]'],
  [/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],
  [/(?<!\d)(?:\+?\(?\d)[\d\s().-]{8,}\d(?!\d)/g, '[REDACTED_PHONE]'],
];

export function sanitizeDotAlertText(value: unknown): string {
  let text = String(value ?? '');
  for (const [pattern, replacement] of ALERT_REDACTIONS) text = text.replace(pattern, replacement);
  return text.slice(0, 300);
}

export function buildDotBudgetAlert(snapshot: DotBudgetSnapshot): DotBudgetAlert | null {
  if (snapshot.ambiguous > 0) {
    return {
      event: 'dot_budget_ambiguous',
      severity: 'warning',
      percent: Math.round(snapshot.percent * 1000) / 1000,
      used: snapshot.used,
      reserved: snapshot.reserved,
      limit: snapshot.limit,
      reason: sanitizeDotAlertText('reservas ambíguas aguardando reconciliação comprometem o orçamento'),
    };
  }
  if (snapshot.limit > 0 && snapshot.remaining <= 0) {
    return {
      event: 'dot_budget_exhausted',
      severity: 'critical',
      percent: 1,
      used: snapshot.used,
      reserved: snapshot.reserved,
      limit: snapshot.limit,
      reason: sanitizeDotAlertText('orçamento de IA do plano esgotado para o período'),
    };
  }
  if (snapshot.warning) {
    return {
      event: 'dot_budget_warning',
      severity: 'warning',
      percent: Math.round(snapshot.percent * 1000) / 1000,
      used: snapshot.used,
      reserved: snapshot.reserved,
      limit: snapshot.limit,
      reason: sanitizeDotAlertText('consumo acima de 80% do orçamento de IA do plano'),
    };
  }
  return null;
}

/** Emite o alerta (log estruturado, sanitizado). Nunca lança. */
export function emitDotBudgetAlert(alert: DotBudgetAlert | null): void {
  if (!alert) return;
  incCounter('dot_budget_alert_emitted');
  incCounter(alert.event === 'dot_budget_exhausted' ? 'dot_budget_alert_critical' : 'dot_budget_alert_warning');
  logEvent(alert.severity === 'critical' ? 'error' : 'warn', 'dot_budget_alert', {
    alert_event: alert.event,
    severity: alert.severity,
    percent: alert.percent,
    used: alert.used,
    reserved: alert.reserved,
    limit: alert.limit,
  });
  try {
    console.warn('[dot-budget-alert] ' + JSON.stringify(alert));
  } catch {
    /* observabilidade nunca derruba a requisição */
  }
}

/** Exposto para testes: limite de orçamento efetivo do Dot por plano. */
export function dotFeatureLimitForPlan(plan: string | null | undefined): number {
  return getFeatureTokenLimit(normalizePlanForQuota(plan), DOT_FEATURE);
}
