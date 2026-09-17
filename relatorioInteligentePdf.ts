import type { Database } from 'sqlite';
import PDFDocument from 'pdfkit';
import { planTemPdf } from './lib/plans.js';

type Review = {
  rating?: number | string;
  comment?: string | null;
  sentiment?: string | null;
  ai_tags?: string | null;
  createdAt?: string;
  created_at?: string;
  is_test?: number | boolean | null;
};

function inCycle(value: string, start: string, end: string): boolean {
  const t = new Date(value).getTime();
  return Number.isFinite(t) && t >= new Date(start).getTime() && t < new Date(end).getTime();
}

function sentiment(reviews: Review[]) {
  let positivo = 0, neutro = 0, negativo = 0;
  for (const r of reviews) {
    const s = String(r.sentiment || '').toLowerCase();
    const n = Number(r.rating);
    if (s.includes('pos')) positivo++;
    else if (s.includes('neg')) negativo++;
    else if (s.includes('neu')) neutro++;
    else if (n >= 4) positivo++;
    else if (n <= 2) negativo++;
    else neutro++;
  }
  return { positivo, neutro, negativo };
}

function tags(reviews: Review[]) {
  const counts: Record<string, number> = {};
  for (const r of reviews) {
    try {
      const list = JSON.parse(String(r.ai_tags || '[]'));
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const key = String(item || '').trim();
        if (key) counts[key] = (counts[key] || 0) + 1;
      }
    } catch { /* ignore malformed tags */ }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
}

export async function gerarRelatorioInteligentePDF(
  db: Database,
  empresaId: string,
  inicio: string,
  fim: string,
  lang = 'pt'
): Promise<Buffer> {
  const empresa: any = await db.get(
    'SELECT id, nome_empresa, plan, status FROM empresas WHERE id = ?',
    [empresaId]
  );
  if (!empresa) throw new Error('Empresa não encontrada.');
  if (!planTemPdf(empresa.plan || empresa.status)) throw new Error('Plano não elegível para PDF.');

  const rows = (await db.all(
    'SELECT rating, comment, sentiment, ai_tags, createdAt, is_test FROM reviews WHERE empresa_id = ? ORDER BY createdAt ASC LIMIT 10000',
    [empresaId]
  )) as Review[];
  const reviews = rows.filter((r) => !r.is_test && inCycle(String(r.createdAt || r.created_at || ''), inicio, fim));

  let sum = 0;
  let positive = 0;
  let critical = 0;
  const dist = [0, 0, 0, 0, 0];
  for (const r of reviews) {
    const n = Number(r.rating);
    if (!Number.isFinite(n) || n < 1 || n > 5) continue;
    sum += n;
    dist[n - 1]++;
    if (n >= 4) positive++;
    if (n <= 3) critical++;
  }
  const rated = reviews.filter((r) => Number.isFinite(Number(r.rating)) && Number(r.rating) >= 1 && Number(r.rating) <= 5);
  const avg = rated.length ? sum / rated.length : 0;
  const sent = sentiment(reviews);
  const themeRows = tags(reviews);

  const labels = {
    pt: { title: 'Relatório Inteligente', avg: 'Nota média', reviews: 'Avaliações', positive: 'Positivas', critical: 'Pontos de atenção', period: 'Dados atuais até', distribution: 'Distribuição das avaliações', sentiment: 'Sentimento', positiveS: 'Positivo', neutralS: 'Neutro', negativeS: 'Negativo', themes: 'Principais temas', noThemes: 'Nenhum tema recorrente disponível.', recommendations: 'Recomendações', conclusion: 'Conclusão', page: 'Página' },
    en: { title: 'Intelligent Report', avg: 'Average rating', reviews: 'Reviews', positive: 'Positive', critical: 'Points of attention', period: 'Current data until', distribution: 'Review distribution', sentiment: 'Sentiment', positiveS: 'Positive', neutralS: 'Neutral', negativeS: 'Negative', themes: 'Main themes', noThemes: 'No recurring themes available.', recommendations: 'Recommendations', conclusion: 'Conclusion', page: 'Page' },
    es: { title: 'Informe Inteligente', avg: 'Calificación media', reviews: 'Reseñas', positive: 'Positivas', critical: 'Puntos de atención', period: 'Datos actuales hasta', distribution: 'Distribución de reseñas', sentiment: 'Sentimiento', positiveS: 'Positivo', neutralS: 'Neutral', negativeS: 'Negativo', themes: 'Temas principales', noThemes: 'No hay temas recurrentes disponibles.', recommendations: 'Recomendaciones', conclusion: 'Conclusión', page: 'Página' },
    zh: { title: '智能报告', avg: '平均评分', reviews: '评价', positive: '好评', critical: '需关注', period: '当前数据截至', distribution: '评价分布', sentiment: '情绪', positiveS: '积极', neutralS: '中性', negativeS: '消极', themes: '主要主题', noThemes: '暂无重复主题。', recommendations: '建议', conclusion: '结论', page: '页' },
  } as const;
  const t = labels[(lang === 'en' || lang === 'es' || lang === 'zh' ? lang : 'pt') as keyof typeof labels];

  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, compress: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  const period = fim;
  const company = String(empresa.nome_empresa || 'Empresa');
  doc.rect(0, 0, doc.page.width, 72).fill('#0f172a');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text('Filtra.AI', 48, 20);
  doc.fillColor('#a5b4fc').font('Helvetica').fontSize(9).text(t.title, 48, 45);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text(company, 350, 24, { width: 195, align: 'right' });
  doc.fillColor('#94a3b8').font('Helvetica').fontSize(8).text(`${t.period}: ${period}`, 350, 42, { width: 195, align: 'right' });
  doc.y = 96;

  doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(17).text(t.title);
  doc.moveDown(0.25);
  doc.fillColor('#64748b').font('Helvetica').fontSize(9).text(`${t.period}: ${period}`);
  doc.moveDown(1);

  const cards = [
    [t.avg, avg ? avg.toFixed(1) : '—'],
    [t.reviews, String(reviews.length)],
    [t.positive, String(positive)],
    [t.critical, String(critical)],
  ];
  const gap = 8, width = (doc.page.width - 96 - gap * 3) / 4;
  const y = doc.y;
  cards.forEach(([label, value], i) => {
    const x = 48 + i * (width + gap);
    doc.roundedRect(x, y, width, 60, 6).fillAndStroke('#f1f5f9', '#e2e8f0');
    doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(7).text(label.toUpperCase(), x + 9, y + 9, { width: width - 18 });
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(18).text(value, x + 9, y + 28, { width: width - 18 });
  });
  doc.y = y + 82;

  const section = (name: string) => {
    doc.moveDown(0.4);
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text(name);
    doc.moveDown(0.35);
  };

  section(t.distribution);
  dist.forEach((value, i) => {
    const bar = Math.max(2, value / Math.max(...dist, 1) * 300);
    doc.fillColor('#334155').font('Helvetica').fontSize(9).text(`${i + 1} ★`, 48, doc.y, { width: 70 });
    doc.roundedRect(125, doc.y + 1, bar, 10, 2).fill('#4f46e5');
    doc.fillColor('#64748b').text(String(value), 435, doc.y, { width: 60 });
    doc.y += 18;
  });

  section(t.sentiment);
  doc.fillColor('#16a34a').font('Helvetica-Bold').fontSize(9).text(`${t.positiveS}: ${sent.positivo}`);
  doc.fillColor('#d97706').text(`${t.neutralS}: ${sent.neutro}`);
  doc.fillColor('#dc2626').text(`${t.negativeS}: ${sent.negativo}`);

  section(t.themes);
  if (!themeRows.length) doc.fillColor('#64748b').font('Helvetica').fontSize(9).text(t.noThemes);
  for (const [name, count] of themeRows) {
    doc.fillColor('#1e293b').font('Helvetica').fontSize(9).text(`• ${name} (${count})`, { width: 500 });
  }

  section(t.recommendations);
  const recommendations = [
    critical > positive ? (lang === 'en' ? 'Prioritize reviews of 3 stars or less.' : lang === 'es' ? 'Prioriza las reseñas de 3 estrellas o menos.' : lang === 'zh' ? '优先处理三星及以下评价。' : 'Priorize as avaliações de até 3 estrelas.') : (lang === 'en' ? 'Maintain the practices generating positive reviews.' : lang === 'es' ? 'Mantén las prácticas que generan reseñas positivas.' : lang === 'zh' ? '保持带来积极评价的做法。' : 'Mantenha os padrões que estão gerando avaliações positivas.'),
    avg && avg < 4 ? (lang === 'en' ? 'Identify the causes of low ratings and turn them into operational actions.' : lang === 'es' ? 'Identifica las causas de las bajas calificaciones y conviértelas en acciones.' : lang === 'zh' ? '找出低评分原因并转化为行动。' : 'Identifique as causas das notas baixas e transforme-as em ações.') : (lang === 'en' ? 'Continue monitoring rating and review volume.' : lang === 'es' ? 'Continúa monitorizando la evolución de la media y el volumen.' : lang === 'zh' ? '继续监测评分和评价量的变化。' : 'Continue monitorando a evolução da média e do volume de avaliações.'),
    sent.negativo > sent.positivo ? (lang === 'en' ? 'Monitor negative sentiment.' : lang === 'es' ? 'Acompaña el sentimiento negativo.' : lang === 'zh' ? '继续监测负面情绪。' : 'Acompanhe o sentimento negativo.') : (lang === 'en' ? 'Use recurring positive themes to maintain customer experience.' : lang === 'es' ? 'Usa los temas positivos recurrentes para mantener la experiencia.' : lang === 'zh' ? '利用反复出现的积极主题来保持客户体验。' : 'Use os temas positivos recorrentes para manter a experiência do cliente.'),
  ];
  recommendations.forEach((r) => doc.fillColor('#1e293b').font('Helvetica').fontSize(9).text(`• ${r}`, { width: 500 }));

  section(t.conclusion);
  const conclusion = reviews.length
    ? (lang === 'en' ? `The company received ${reviews.length} review(s), with an average rating of ${avg ? avg.toFixed(1) : 'not available'}.` : lang === 'es' ? `La empresa recibió ${reviews.length} reseña(s), con una calificación media de ${avg ? avg.toFixed(1) : 'no disponible'}.` : lang === 'zh' ? `公司收到 ${reviews.length} 条评价，平均评分为 ${avg ? avg.toFixed(1) : '不可用'}。` : `A empresa recebeu ${reviews.length} avaliação(ões), com nota média ${avg ? avg.toFixed(1) : 'não disponível'}.`)
    : (lang === 'en' ? 'There were no valid reviews in the current period.' : lang === 'es' ? 'No hubo reseñas válidas en el período actual.' : lang === 'zh' ? '当前期间没有有效评价。' : 'Não houve avaliações válidas no período atual.');
  doc.fillColor('#334155').font('Helvetica').fontSize(9).text(conclusion, { width: 500, lineGap: 3 });

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.strokeColor('#e2e8f0').moveTo(48, doc.page.height - 38).lineTo(doc.page.width - 48, doc.page.height - 38).stroke();
    doc.fillColor('#94a3b8').font('Helvetica').fontSize(7).text(`Filtra.AI • ${period}`, 48, doc.page.height - 28);
    doc.text(`${t.page} ${i + 1}/${range.count}`, doc.page.width - 110, doc.page.height - 28, { width: 62, align: 'right' });
  }

  await new Promise<void>((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
    doc.end();
  });
  const buf = Buffer.concat(chunks);
  if (!buf.length || buf.subarray(0, 4).toString() !== '%PDF') throw new Error('PDF inválido.');
  return buf;
}
