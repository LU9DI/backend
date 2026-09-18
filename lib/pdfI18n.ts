/**
 * i18n + benefícios por plano para o PDF mensal Filtra.AI
 * Textos alinhados ao sample visual (HTML→PDF de referência).
 */

export type PdfLang = 'pt' | 'en' | 'es' | 'zh';
export type PdfDepth = 'pro' | 'ultra' | 'corp' | 'rei';

const DICT: Record<PdfLang, Record<string, string>> = {
  pt: {
    subtitle: 'Relatório de reputação inteligente',
    page: 'Pág. {{n}} / {{t}}',
    benefits_in: 'Benefícios deste PDF',
    benefits_out: 'Não incluso neste plano',
    period: 'Ciclo',
    plan: 'Plano',
    summary: 'Resumo do ciclo',
    volume: 'Volume',
    volume_sub: 'avaliações',
    avg: 'Nota média',
    avg_sub: 'escala 1–5',
    critical: 'Críticas',
    critical_sub: '1–3★',
    positive: 'Positivas',
    positive_sub: '4–5★',
    dist: 'Distribuição de notas',
    sentiment: 'Sentimento (benefício Ultra+)',
    sent_pos: 'Positivo',
    sent_neu: 'Neutro',
    sent_neg: 'Negativo',
    themes: 'Temas da IA (benefício Ultra+)',
    themes_empty:
      'Nenhum tema neste ciclo ainda — a seção faz parte do seu plano e aparece assim que houver tags de IA.',
    ranking: 'Ranking de unidades',
    branch: 'Filial',
    empty: 'Nenhuma avaliação registrada neste ciclo.',
    rights:
      '© Filtra.AI — Todos os direitos reservados. Uso exclusivo de {{empresa}}. Documento confidencial.',
    brand: 'Filtra.AI',
    watermark: 'FILTRA.AI',
    tagline: 'Online Reputation',
    footer_line: 'Filtra.AI · PDF {{plano}} · benefícios do plano · ciclo de assinatura',
  },
  en: {
    subtitle: 'Intelligent reputation report',
    page: 'Page {{n}} / {{t}}',
    benefits_in: 'Benefits in this PDF',
    benefits_out: 'Not included in this plan',
    period: 'Cycle',
    plan: 'Plan',
    summary: 'Cycle summary',
    volume: 'Volume',
    volume_sub: 'reviews',
    avg: 'Average',
    avg_sub: 'scale 1–5',
    critical: 'Critical',
    critical_sub: '1–3★',
    positive: 'Positive',
    positive_sub: '4–5★',
    dist: 'Rating distribution',
    sentiment: 'Sentiment (Ultra+ benefit)',
    sent_pos: 'Positive',
    sent_neu: 'Neutral',
    sent_neg: 'Negative',
    themes: 'AI themes (Ultra+ benefit)',
    themes_empty:
      'No themes in this cycle yet — this section is part of your plan and appears when AI tags exist.',
    ranking: 'Unit ranking',
    branch: 'Branch',
    empty: 'No reviews recorded in this cycle.',
    rights: '© Filtra.AI — All rights reserved. Exclusive use for {{empresa}}. Confidential.',
    brand: 'Filtra.AI',
    watermark: 'FILTRA.AI',
    tagline: 'Online Reputation',
    footer_line: 'Filtra.AI · PDF {{plano}} · plan benefits · subscription cycle',
  },
  es: {
    subtitle: 'Informe de reputación inteligente',
    page: 'Pág. {{n}} / {{t}}',
    benefits_in: 'Beneficios de este PDF',
    benefits_out: 'No incluido en este plan',
    period: 'Ciclo',
    plan: 'Plan',
    summary: 'Resumen del ciclo',
    volume: 'Volumen',
    volume_sub: 'reseñas',
    avg: 'Nota media',
    avg_sub: 'escala 1–5',
    critical: 'Críticas',
    critical_sub: '1–3★',
    positive: 'Positivas',
    positive_sub: '4–5★',
    dist: 'Distribución de notas',
    sentiment: 'Sentimiento (beneficio Ultra+)',
    sent_pos: 'Positivo',
    sent_neu: 'Neutro',
    sent_neg: 'Negativo',
    themes: 'Temas de IA (beneficio Ultra+)',
    themes_empty:
      'Ningún tema en este ciclo aún — la sección forma parte de tu plan y aparece con tags de IA.',
    ranking: 'Ranking de unidades',
    branch: 'Sucursal',
    empty: 'No hay reseñas en este ciclo.',
    rights:
      '© Filtra.AI — Todos los derechos reservados. Uso exclusivo de {{empresa}}. Confidencial.',
    brand: 'Filtra.AI',
    watermark: 'FILTRA.AI',
    tagline: 'Online Reputation',
    footer_line: 'Filtra.AI · PDF {{plano}} · beneficios del plan · ciclo de suscripción',
  },
  zh: {
    subtitle: '智能声誉报告',
    page: '第 {{n}} / {{t}} 页',
    benefits_in: '本 PDF 权益',
    benefits_out: '本套餐不含',
    period: '周期',
    plan: '套餐',
    summary: '周期摘要',
    volume: '数量',
    volume_sub: '评价',
    avg: '平均分',
    avg_sub: '1–5 分',
    critical: '差评',
    critical_sub: '1–3★',
    positive: '好评',
    positive_sub: '4–5★',
    dist: '评分分布',
    sentiment: '情感分析（Ultra+）',
    sent_pos: '正面',
    sent_neu: '中性',
    sent_neg: '负面',
    themes: 'AI 主题（Ultra+）',
    themes_empty: '本周期尚主题 — 该板块属于您的套餐，有 AI 标签时显示。',
    ranking: '门店排名',
    branch: '分店',
    empty: '本周期无评价。',
    rights: '© Filtra.AI — 保留所有权利。仅供 {{empresa}} 使用。机密文件。',
    brand: 'Filtra.AI',
    watermark: 'FILTRA.AI',
    tagline: 'Online Reputation',
    footer_line: 'Filtra.AI · PDF {{plano}} · 套餐权益 · 订阅周期',
  },
};

export function normalizePdfLang(raw?: string | null): PdfLang {
  const s = String(raw || '').toLowerCase().trim();
  if (s.startsWith('en')) return 'en';
  if (s.startsWith('es')) return 'es';
  if (s.startsWith('zh') || s.startsWith('cn')) return 'zh';
  return 'pt';
}

export function monthPeriod(mesAno: string, lang: PdfLang): string {
  const [y, m] = String(mesAno || '').split('-');
  const month = Number(m) || 1;
  const year = y || String(new Date().getFullYear());
  const names: Record<PdfLang, string[]> = {
    pt: [
      'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
      'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
    ],
    en: [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ],
    es: [
      'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
    ],
    zh: ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'],
  };
  return `${names[lang][month - 1] || month}/${year}`;
}

export function t(lang: PdfLang, key: string, vars?: Record<string, string | number>): string {
  let s = DICT[lang]?.[key] ?? DICT.pt[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split('{{' + k + '}}').join(String(v));
    }
  }
  return s;
}

/** Checklist de benefícios — textos do sample ULTRA. */
export function featureChecklist(
  depth: PdfDepth,
  lang: PdfLang
): { label: string; included: boolean }[] {
  const labels: Record<PdfLang, { key: string; min: PdfDepth; text: string }[]> = {
    pt: [
      { key: 'kpis', min: 'pro', text: 'Tudo do Pro' },
      { key: 'sent', min: 'ultra', text: 'Sentimento: positivo / neutro / negativo' },
      { key: 'themes', min: 'ultra', text: 'Temas principais detectados pela IA' },
      { key: 'rank', min: 'corp', text: 'Ranking de filiais (Corporativo+)' },
      { key: 'branch', min: 'rei', text: 'Ficha detalhada por unidade (Rei)' },
    ],
    en: [
      { key: 'kpis', min: 'pro', text: 'Everything in Pro' },
      { key: 'sent', min: 'ultra', text: 'Sentiment: positive / neutral / negative' },
      { key: 'themes', min: 'ultra', text: 'Main themes detected by AI' },
      { key: 'rank', min: 'corp', text: 'Branch ranking (Corporate+)' },
      { key: 'branch', min: 'rei', text: 'Detailed page per unit (Rei)' },
    ],
    es: [
      { key: 'kpis', min: 'pro', text: 'Todo de Pro' },
      { key: 'sent', min: 'ultra', text: 'Sentimiento: positivo / neutro / negativo' },
      { key: 'themes', min: 'ultra', text: 'Temas principales detectados por IA' },
      { key: 'rank', min: 'corp', text: 'Ranking de sucursales (Corporativo+)' },
      { key: 'branch', min: 'rei', text: 'Ficha detallada por unidad (Rei)' },
    ],
    zh: [
      { key: 'kpis', min: 'pro', text: '含 Pro' },
      { key: 'sent', min: 'ultra', text: '情感：正面 / 中性 / 负面' },
      { key: 'themes', min: 'ultra', text: 'AI 检测的主要主题' },
      { key: 'rank', min: 'corp', text: '门店排名（企业版+）' },
      { key: 'branch', min: 'rei', text: '每店详情页（Rei）' },
    ],
  };
  const rank: Record<PdfDepth, number> = { pro: 1, ultra: 2, corp: 3, rei: 4 };
  const current = rank[depth] || 1;
  return (labels[lang] || labels.pt).map((o) => ({
    label: o.text,
    included: current >= rank[o.min],
  }));
}

export function planTitle(depth: PdfDepth, lang: PdfLang): string {
  const map: Record<PdfDepth, Record<PdfLang, string>> = {
    pro: { pt: 'PLANO PRO', en: 'PRO PLAN', es: 'PLAN PRO', zh: 'PRO 套餐' },
    ultra: { pt: 'PLANO ULTRA', en: 'ULTRA PLAN', es: 'PLAN ULTRA', zh: 'ULTRA 套餐' },
    corp: { pt: 'PLANO CORPORATIVO', en: 'CORPORATE PLAN', es: 'PLAN CORPORATIVO', zh: '企业版' },
    rei: { pt: 'PLANO REI', en: 'REI PLAN', es: 'PLAN REI', zh: 'REI 套餐' },
  };
  return map[depth][lang];
}

export function planSubtitle(depth: PdfDepth, lang: PdfLang): string {
  const map: Record<PdfDepth, Record<PdfLang, string>> = {
    pro: {
      pt: 'Essencial — KPIs e distribuição',
      en: 'Essential — KPIs and distribution',
      es: 'Esencial — KPIs y distribución',
      zh: '基础 — KPI 与分布',
    },
    ultra: {
      pt: 'Essencial + inteligência de sentimento',
      en: 'Essential + sentiment intelligence',
      es: 'Esencial + inteligencia de sentimiento',
      zh: '基础 + 情感智能',
    },
    corp: {
      pt: 'Ultra + multi-unidade e ranking',
      en: 'Ultra + multi-unit ranking',
      es: 'Ultra + multiunidad y ranking',
      zh: 'Ultra + 多门店排名',
    },
    rei: {
      pt: 'Executivo completo — filiais e visão avançada',
      en: 'Full executive — branches and advanced view',
      es: 'Ejecutivo completo — sucursales y visión avanzada',
      zh: '完整高管版 — 门店与高级视图',
    },
  };
  return map[depth][lang];
}
