/**
 * Janela de envio da captação, em horário de Brasília.
 * Padrão: 9h às 17h, segunda a sexta.
 * Configurável por ACQUISITION_SEND_HOURS="9-17" e ACQUISITION_SEND_WEEKENDS=1.
 */
export function inSendWindow(now = new Date()): boolean {
  const raw = String(process.env.ACQUISITION_SEND_HOURS || '9-17').trim().slice(0, 20);
  const [startRaw, endRaw] = raw.split('-');
  const startNum = Number(startRaw);
  const endNum = Number(endRaw);
  const start = Number.isFinite(startNum) ? Math.min(23, Math.max(0, startNum)) : 9;
  const end = Number.isFinite(endNum) ? Math.min(24, Math.max(start + 1, endNum)) : 17;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hour: 'numeric',
    hourCycle: 'h23',
    weekday: 'short'
  }).formatToParts(now);
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? -1);
  const weekday = String(parts.find(p => p.type === 'weekday')?.value || '');
  const weekend = weekday === 'Sat' || weekday === 'Sun';
  if (weekend && process.env.ACQUISITION_SEND_WEEKENDS !== '1') return false;
  return hour >= start && hour < end;
}
