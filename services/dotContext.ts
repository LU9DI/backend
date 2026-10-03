import { getDb, findEmpresa } from '../lib/db.js';

export async function loadDotRealContext(empresaId: string): Promise<string> {
  const db = getDb();
  const empresa = await findEmpresa(empresaId);
  if (!empresa) throw new Error('Empresa não encontrada.');

  const queries = [
    'SELECT * FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC NULLS LAST LIMIT ?',
    'SELECT * FROM reviews WHERE empresa_id = ? ORDER BY "createdAt" DESC LIMIT ?',
    'SELECT * FROM reviews WHERE empresa_id = ? ORDER BY id DESC LIMIT ?',
  ];

  let rows: any[] = [];
  for (const query of queries) {
    try {
      rows = await db.all(query, [empresaId, 500]);
      break;
    } catch {
      // Try the next compatible ordering.
    }
  }

  const real = (rows || []).filter((r: any) => Number(r.is_test) !== 1);
  const total = real.length;
  const average = total
    ? Math.round((real.reduce((sum: number, r: any) => sum + Number(r.rating || 0), 0) / total) * 10) / 10
    : 0;
  const positive = real.filter((r: any) => Number(r.rating) >= 4).length;
  const critical = real.filter((r: any) => Number(r.rating) <= 3).length;

  const counts: Record<string, number> = {};
  for (const review of real) {
    let parsed: unknown = [];
    try { parsed = JSON.parse(String(review.ai_tags || '[]')); } catch {}
    if (Array.isArray(parsed)) {
      for (const tag of parsed) {
        const key = String(tag).trim();
        if (key) counts[key] = (counts[key] || 0) + 1;
      }
    }
  }

  const themes = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  return [
    'CONTEXTO REAL DA EMPRESA AUTENTICADA:',
    `- Empresa: ${empresa.nome_empresa}`,
    `- Plano: ${String(empresa.plan || 'trial')}`,
    `- Avaliações reais analisadas: ${total}`,
    `- Nota média: ${average}/5`,
    `- Positivas (4–5★): ${positive}`,
    `- Críticas (1–3★): ${critical}`,
    `- Principais temas da IA: ${JSON.stringify(themes)}`,
    '- Não invente métricas além destas informações.',
  ].join('\n');
}
