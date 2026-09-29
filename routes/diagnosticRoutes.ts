import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { callAI } from '../groqService.js';

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false, message: { error: 'Limite de diagnósticos atingido. Tente novamente mais tarde.' } });

function reviews(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((r: any) => ({ rating: Number(r?.rating), text: String(r?.text ?? r?.comment ?? '').trim().slice(0, 2000) }))
    .filter((r) => Number.isFinite(r.rating) && r.rating >= 1 && r.rating <= 5 && r.text.length >= 3).slice(0, 30);
}

function parse(text: string) {
  const cleaned = text.replace(/^\s*```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

export function mountDiagnosticRoutes(app: Express) {
  app.post('/api/public/diagnostic', limiter, async (req: Request, res: Response) => {
    const company = String(req.body?.company || '').trim().slice(0, 160);
    const locale = String(req.body?.locale || 'pt').trim().slice(0, 10);
    const items = reviews(req.body?.reviews);
    if (company.length < 2) return res.status(400).json({ error: 'Informe o nome da empresa.' });
    if (items.length < 3) return res.status(400).json({ error: 'Envie pelo menos 3 avaliações reais para gerar o diagnóstico.' });
    const average = items.reduce((sum, r) => sum + r.rating, 0) / items.length;
    const distribution = [1,2,3,4,5].map((rating) => ({ rating, count: items.filter((r) => r.rating === rating).length }));
    const system = 'Você é o analista de reputação da Filtra.AI. Analise somente as avaliações fornecidas. Não invente fatos, métricas, clientes, canais ou causas. Responda em JSON válido com as chaves: summary, strengths, risks, recurring_themes, actions, confidence. Cada afirmação deve ser sustentada pelo texto recebido. Locale: ' + locale + '.';
    const user = JSON.stringify({ company, review_count: items.length, average_rating: Number(average.toFixed(2)), distribution, reviews: items });
    try {
      const ai = await callAI(system, user, 700, 0.2, { tipo: 'public_diagnostic' });
      const analysis = parse(ai.text);
      if (!analysis) return res.status(502).json({ error: 'Não foi possível estruturar o diagnóstico agora. Tente novamente.' });
      return res.json({ ok: true, diagnostic: { company, review_count: items.length, average_rating: Number(average.toFixed(2)), positive_count: items.filter((r) => r.rating >= 4).length, negative_count: items.filter((r) => r.rating <= 2).length, distribution, ...analysis }, provider: ai.provider });
    } catch (error: any) {
      return res.status(503).json({ error: 'Diagnóstico temporariamente indisponível.', detail: process.env.NODE_ENV === 'production' ? undefined : String(error?.message || error) });
    }
  });
}
