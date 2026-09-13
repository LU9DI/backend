/**
 * Ciclo de relatório alinhado à data de assinatura / trial.
 * Ex.: assinou dia 15 → ciclo 15/09 → 14/10 (não 01/09 → 30/09).
 */

export type CycleRange = {
  /** Início inclusivo ISO */
  startIso: string;
  /** Fim exclusivo ISO */
  endIso: string;
  /** Rótulo legível pt-BR */
  label: string;
  /** Dia âncora 1–31 */
  anchorDay: number;
  /** YYYY-MM do início do ciclo */
  cycleKey: string;
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Extrai Date de vários formatos de campo da empresa. */
export function parseEmpresaDate(raw: unknown): Date | null {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
  const s = String(raw).trim();
  if (!s) return null;
  // YYYY-MM-DD ou ISO
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  return null;
}

/**
 * Âncora do ciclo: preferência assinatura → trial → criação.
 * Fallback: dia 1 (comportamento antigo só se não houver data).
 */
export function subscriptionAnchorDay(empresa: Record<string, any> | null | undefined): number {
  const candidates = [
    empresa?.assinatura_em,
    empresa?.plan_started_at,
    empresa?.plano_inicio,
    empresa?.data_plano,
    empresa?.trial_start,
    empresa?.trial_started_at,
    empresa?.criado_em,
    empresa?.created_at,
    empresa?.createdAt,
  ];
  for (const c of candidates) {
    const d = parseEmpresaDate(c);
    if (d) {
      const day = d.getUTCDate();
      if (day >= 1 && day <= 31) return day;
    }
  }
  return 1;
}

/** Dia válido no mês (ex.: âncora 31 em fevereiro → 28/29). */
function clampDay(year: number, monthIndex0: number, day: number): number {
  const last = new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
  return Math.min(Math.max(1, day), last);
}

function utcDate(year: number, monthIndex0: number, day: number): Date {
  const d = clampDay(year, monthIndex0, day);
  return new Date(Date.UTC(year, monthIndex0, d, 0, 0, 0, 0));
}

function formatBr(d: Date): string {
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/**
 * Interpreta `mes=YYYY-MM` como o ciclo cuja **data de início** cai naquele mês civil,
 * no dia da assinatura (âncora).
 *
 * Ex.: âncora 15, mes=2026-09 → 15/09/2026 00:00 UTC até 15/10/2026 00:00 UTC (fim exclusivo).
 */
export function cycleRangeForMonth(
  mesAno: string,
  anchorDay: number,
  now = new Date()
): CycleRange {
  const m = /^(\d{4})-(\d{2})$/.exec(String(mesAno || '').trim());
  if (!m) {
    // fallback: ciclo corrente
    return currentCycleRange(anchorDay, now);
  }
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  const start = utcDate(year, month - 1, anchorDay);
  let endYear = year;
  let endMonth0 = month; // next month index 0-based = month (since month is 1-12)
  if (endMonth0 > 11) {
    endMonth0 = 0;
    endYear = year + 1;
  }
  // month is 1-12; next month index = month % 12, year++ if month===12
  if (month === 12) {
    endYear = year + 1;
    endMonth0 = 0;
  } else {
    endMonth0 = month; // e.g. month=9 → end month index 9 = October
  }
  const end = utcDate(endYear, endMonth0, anchorDay);

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    label: `${formatBr(start)} – ${formatBr(new Date(end.getTime() - 86400000))}`,
    anchorDay,
    cycleKey: `${year}-${pad2(month)}`,
  };
}

/** Ciclo que contém `now` (baseado na âncora). */
export function currentCycleRange(anchorDay: number, now = new Date()): CycleRange {
  const y = now.getUTCFullYear();
  const mo = now.getUTCMonth(); // 0-11
  const day = now.getUTCDate();
  const anchorThisMonth = utcDate(y, mo, anchorDay);

  let start: Date;
  let end: Date;
  if (day >= clampDay(y, mo, anchorDay)) {
    start = anchorThisMonth;
    const ny = mo === 11 ? y + 1 : y;
    const nm = mo === 11 ? 0 : mo + 1;
    end = utcDate(ny, nm, anchorDay);
  } else {
    const py = mo === 0 ? y - 1 : y;
    const pm = mo === 0 ? 11 : mo - 1;
    start = utcDate(py, pm, anchorDay);
    end = anchorThisMonth;
  }

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    label: `${formatBr(start)} – ${formatBr(new Date(end.getTime() - 86400000))}`,
    anchorDay,
    cycleKey: `${start.getUTCFullYear()}-${pad2(start.getUTCMonth() + 1)}`,
  };
}

/** Review está dentro do ciclo? [start, end) */
export function inCycleRange(isoDate: string | null, range: CycleRange): boolean {
  if (!isoDate) return true; // sem data: inclui (evita zerar relatório por coluna estranha)
  const t = new Date(isoDate).getTime();
  if (Number.isNaN(t)) return true;
  const a = new Date(range.startIso).getTime();
  const b = new Date(range.endIso).getTime();
  return t >= a && t < b;
}
