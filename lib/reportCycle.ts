/**
 * Ciclo mensal dos relatórios.
 *
 * O período não é baseado no mês-calendário. O ciclo é ancorado no dia
 * em que a assinatura/plano foi iniciado (empresas.criado_em).
 *
 * Ex.: início 15/09 => ciclos 15/09–14/10, 15/10–14/11, ...
 */

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function daysInMonthUtc(year: number, monthZeroBased: number): number {
  return new Date(Date.UTC(year, monthZeroBased + 1, 0)).getUTCDate();
}

/** Adiciona N meses preservando o dia quando possível; no fim do mês, faz clamp. */
export function addMonthsClamped(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const targetMonth = date.getUTCMonth() + months;
  const targetYear = date.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const maxDay = daysInMonthUtc(targetYear, normalizedMonth);

  return new Date(
    Date.UTC(
      targetYear,
      normalizedMonth,
      Math.min(day, maxDay),
      0,
      0,
      0,
      0
    )
  );
}

export type ReportCycle = {
  start: Date;
  endExclusive: Date;
  endInclusive: Date;
  key: string;
};

function keyOf(start: Date, endInclusive: Date): string {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return `${iso(start)}_${iso(endInclusive)}`;
}

/**
 * Retorna o ciclo que contém a data de referência.
 * A data de início é o anchor da assinatura.
 */
export function getCycleForDate(anchorRaw: string | Date, referenceRaw: string | Date = new Date()): ReportCycle {
  const anchor = startOfUtcDay(new Date(anchorRaw));
  const reference = startOfUtcDay(new Date(referenceRaw));

  if (Number.isNaN(anchor.getTime()) || Number.isNaN(reference.getTime())) {
    throw new Error('Data inválida para cálculo do ciclo do relatório.');
  }

  if (reference < anchor) {
    const endExclusive = addMonthsClamped(anchor, 1);
    const endInclusive = new Date(endExclusive.getTime() - 1);
    return {
      start: anchor,
      endExclusive,
      endInclusive,
      key: keyOf(anchor, endInclusive),
    };
  }

  let months =
    (reference.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (reference.getUTCMonth() - anchor.getUTCMonth());

  let start = addMonthsClamped(anchor, months);

  // Para anchors em dias 29–31, o clamp pode fazer a data do aniversário
  // cair antes da referência. Avança um ciclo nesses casos.
  if (start > reference) {
    months -= 1;
    start = addMonthsClamped(anchor, months);
  }

  const endExclusive = addMonthsClamped(anchor, months + 1);
  const endInclusive = new Date(endExclusive.getTime() - 1);

  return {
    start,
    endExclusive,
    endInclusive,
    key: keyOf(start, endInclusive),
  };
}

export function formatCycle(cycle: ReportCycle): string {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return `${fmt(cycle.start)} — ${fmt(cycle.endInclusive)}`;
}

/**
 * Verifica se o ciclo já terminou. O relatório deve ser gerado apenas depois
 * do fim do período, evitando fechar um relatório enquanto ainda entram reviews.
 */
export function cycleEnded(cycle: ReportCycle, now: Date = new Date()): boolean {
  return now.getTime() >= cycle.endExclusive.getTime();
}
