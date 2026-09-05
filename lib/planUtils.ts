// Utilitários para controle de plano e data

/** Extrai o plano do JWT no header Authorization (fallback: trial). */
export function getPlanFromRequest(req: any): string {
  const authHeader = req?.headers?.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) return 'trial';
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.plan ?? 'trial';
  } catch {
    return 'trial';
  }
}

/** Retorna o mês corrente no formato YYYY-MM */
export function getCurrentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}
