/**
 * Janelas de envio da captação, em horário de Brasília, divididas em períodos
 * (manhã, tarde e noite). Padrão: "9-12,14-17,19-21", segunda a sexta.
 * Configurável por ACQUISITION_SEND_HOURS (ex.: "9-17" ou "9-12,14-17,19-21")
 * e ACQUISITION_SEND_WEEKENDS=1.
 */
const DEFAULT_HOURS = '9-12,14-17,19-21';

export type SendPeriod = { start: number; end: number };

export function parseSendPeriods(raw = process.env.ACQUISITION_SEND_HOURS): SendPeriod[] {
  const parse = (text: string): SendPeriod[] => {
    const periods: SendPeriod[] = [];
    for (const part of text.split(',')) {
      const match = part.trim().match(/^(\d{1,2})-(\d{1,2})$/);
      if (!match) return [];
      const start = Math.min(23, Number(match[1]));
      const end = Math.min(24, Number(match[2]));
      if (end <= start) return [];
      periods.push({ start, end });
    }
    return periods.sort((a, b) => a.start - b.start);
  };
  const parsed = parse(String(raw || DEFAULT_HOURS).trim().slice(0, 60));
  return parsed.length ? parsed : parse(DEFAULT_HOURS);
}

function brasiliaNow(now: Date): { hour: number; weekend: boolean } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: 'numeric',
    hourCycle: 'h23',
    weekday: 'short'
  }).formatToParts(now);
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? -1);
  const weekday = String(parts.find(p => p.type === 'weekday')?.value || '');
  return { hour, weekend: weekday === 'Sat' || weekday === 'Sun' };
}

/** Período atual (índice 0-based e total de períodos) ou null se fora da janela. */
export function currentSendPeriod(now = new Date()): { index: number; total: number } | null {
  const { hour, weekend } = brasiliaNow(now);
  if (weekend && process.env.ACQUISITION_SEND_WEEKENDS !== '1') return null;
  const periods = parseSendPeriods();
  const index = periods.findIndex(p => hour >= p.start && hour < p.end);
  return index < 0 ? null : { index, total: periods.length };
}

export function inSendWindow(now = new Date()): boolean {
  return currentSendPeriod(now) !== null;
}

/**
 * Teto acumulado de envios permitido até o fim do período atual, dividindo o
 * teto diário igualmente entre os períodos (ex.: 25/dia em 3 períodos = 9, 17, 25).
 */
export function cumulativeCapForPeriod(dailyCap: number, period: { index: number; total: number }): number {
  return Math.min(dailyCap, Math.ceil((dailyCap * (period.index + 1)) / period.total));
}
