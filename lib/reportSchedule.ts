/**
 * Funções puras de calendário do relatório mensal (testáveis sem DB).
 * Aniversário = dia da assinatura no fuso America/Sao_Paulo (persistido em ISO).
 */

export function dateOnly(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** Mês anterior, mesmo dia (ou último dia do mês se não existir). */
export function previousMonthSameDay(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() - 1, 1);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return dateOnly(d.toISOString());
}

export function previousDay(isoDateOnly: string): string {
  const d = new Date(`${isoDateOnly}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return dateOnly(d.toISOString());
}

/** Próximo vencimento = +1 mês, clamp no último dia. */
export function nextMonthAfterDue(iso: string): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + 1, 1);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString();
}

/**
 * Exemplos de clamp:
 * 2026-01-31 → 2026-02-28
 * 2024-01-31 → 2024-02-29 (bissexto)
 * 2026-03-31 → 2026-04-30
 */
export function calendarExamples() {
  return {
    jan31_to_feb: nextMonthAfterDue('2026-01-31T15:00:00.000Z'),
    jan31_leap: nextMonthAfterDue('2024-01-31T15:00:00.000Z'),
    mar31_to_apr: nextMonthAfterDue('2026-03-31T15:00:00.000Z'),
    day12: nextMonthAfterDue('2026-09-12T18:00:00.000Z'),
  };
}
