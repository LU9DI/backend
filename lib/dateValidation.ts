/**
 * Validação de datas / períodos para API (relatórios, filtros).
 */

export type DateValidationOk = { ok: true; value: string };
export type DateValidationErr = { ok: false; error: string };
export type DateValidationResult = DateValidationOk | DateValidationErr;

const MIN_YEAR = 2020;
const MAX_YEARS_AHEAD = 0; // não permite mês futuro além do atual

/** Mês civil atual em YYYY-MM (fuso local do servidor) */
export function currentMonthYYYYMM(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** Compara YYYY-MM como números (negativo se a < b) */
export function compareYYYYMM(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  if (ya !== yb) return ya - yb;
  return ma - mb;
}

/**
 * Valida parâmetro de mês de relatório.
 * - Formato estrito YYYY-MM
 * - Mês 01–12 real (não 00/13)
 * - Ano entre MIN_YEAR e mês atual (+ MAX_YEARS_AHEAD)
 * - Não aceita mês futuro
 */
export function validateReportMonth(
  raw: unknown,
  opts?: {
    required?: boolean;
    defaultToCurrent?: boolean;
    minYear?: number;
    allowFutureMonths?: number;
    now?: Date;
  }
): DateValidationResult {
  const now = opts?.now ?? new Date();
  const current = currentMonthYYYYMM(now);
  const minYear = opts?.minYear ?? MIN_YEAR;
  const allowFuture = opts?.allowFutureMonths ?? MAX_YEARS_AHEAD;

  if (raw === undefined || raw === null || String(raw).trim() === '') {
    if (opts?.defaultToCurrent !== false) {
      return { ok: true, value: current };
    }
    if (opts?.required) {
      return { ok: false, error: 'Parâmetro mes é obrigatório. Use YYYY-MM (ex.: 2026-09).' };
    }
    return { ok: true, value: current };
  }

  const s = String(raw).trim();

  // rejeita lixo comum
  if (s.length > 7 || /[a-zA-Z]/.test(s) || s.includes('/') || s.includes('.')) {
    return {
      ok: false,
      error: 'Formato de mês inválido. Use YYYY-MM (ex.: 2026-09).',
    };
  }

  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m) {
    return {
      ok: false,
      error: 'Formato de mês inválido. Use YYYY-MM (ex.: 2026-09).',
    };
  }

  const year = Number(m[1]);
  const month = Number(m[2]);

  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    return { ok: false, error: 'Mês inválido.' };
  }

  if (month < 1 || month > 12) {
    return {
      ok: false,
      error: 'Mês inválido. O mês deve estar entre 01 e 12.',
    };
  }

  if (year < minYear) {
    return {
      ok: false,
      error: `Ano muito antigo. Use a partir de ${minYear}.`,
    };
  }

  const maxYear = now.getFullYear() + (allowFuture > 0 ? Math.ceil(allowFuture / 12) : 0);
  if (year > maxYear + 1) {
    return { ok: false, error: 'Ano inválido (futuro demais).' };
  }

  const normalized = `${year}-${String(month).padStart(2, '0')}`;

  // limite superior: mês atual + allowFuture
  const maxDate = new Date(now.getFullYear(), now.getMonth() + allowFuture, 1);
  const maxMonth = currentMonthYYYYMM(maxDate);

  if (compareYYYYMM(normalized, maxMonth) > 0) {
    return {
      ok: false,
      error: `Não é possível gerar relatório de mês futuro. Máximo: ${maxMonth}.`,
    };
  }

  // sanity: data real (ex. não “2026-02” inválido — todos 01-12 ok)
  const probe = new Date(year, month - 1, 1);
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1) {
    return { ok: false, error: 'Data inválida.' };
  }

  return { ok: true, value: normalized };
}

/** Valida intervalo opcional de datas ISO (YYYY-MM-DD) */
export function validateIsoDate(
  raw: unknown,
  fieldName = 'data'
): DateValidationResult {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: false, error: `${fieldName} é obrigatória.` };
  }
  const s = String(raw).trim().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    return { ok: false, error: `${fieldName} inválida. Use YYYY-MM-DD.` };
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    return { ok: false, error: `${fieldName} inválida (dia inexistente no calendário).` };
  }
  return { ok: true, value: s };
}

export function validateDateRange(
  fromRaw: unknown,
  toRaw: unknown
): { ok: true; from: string; to: string } | { ok: false; error: string } {
  const from = validateIsoDate(fromRaw, 'data_inicio');
  if (!from.ok) return from;
  const to = validateIsoDate(toRaw, 'data_fim');
  if (!to.ok) return to;
  if (from.value > to.value) {
    return { ok: false, error: 'data_inicio não pode ser posterior a data_fim.' };
  }
  return { ok: true, from: from.value, to: to.value };
}
