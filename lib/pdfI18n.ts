/** Textos do relatório PDF — pt | en | es | zh */

export type PdfLang = 'pt' | 'en' | 'es' | 'zh';

export function normalizePdfLang(raw?: string | null): PdfLang {
  const s = String(raw || 'pt').toLowerCase().trim();
  if (s.startsWith('en')) return 'en';
  if (s.startsWith('es') || s.startsWith('spa')) return 'es';
  if (s.startsWith('zh') || s.startsWith('cn') || s.includes('chinese') || s === '中文') return 'zh';
  return 'pt';
}

const MONTHS: Record<PdfLang, string[]> = {
  pt: [
    'Janeiro',
    'Fevereiro',
    'Marco',
    'Abril',
    'Maio',
    'Junho',
    'Julho',
    'Agosto',
    'Setembro',
    'Outubro',
    'Novembro',
    'Dezembro',
  ],
  en: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ],
  es: [
    'Enero',
    'Febrero',
    'Marzo',
    'Abril',
    'Mayo',
    'Junio',
    'Julio',
    'Agosto',
    'Septiembre',
    'Octubre',
    'Noviembre',
    'Diciembre',
  ],
  zh: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
};

export function monthPeriod(mesAno: string, lang: PdfLang): string {
  const [ano, mes] = mesAno.split('-');
  const m = Number(mes);
  if (ano && m >= 1 && m <= 12) {
    if (lang === 'zh') return `${ano}年${MONTHS.zh[m - 1]}`;
    return `${MONTHS[lang][m - 1]} / ${ano}`;
  }
  return mesAno;
}

type Dict = Record<string, string>;

const T: Record<PdfLang, Dict> = {
  pt: {
    subtitle: 'Relatorio mensal de reputacao',
    badge_pro: 'Essencial',
    badge_ultra: 'Com IA',
    badge_corp: 'Multi-unidade',
    badge_rei: 'Completo - Rei',
    period: 'Periodo',
    plan: 'Plano',
    summary: 'Resumo do periodo',
    volume: 'Volume',
    volume_sub: 'Avaliacoes validas',
    avg: 'Nota media',
    avg_sub: 'Escala 1 a 5',
    critical: 'Criticas',
    critical_sub: 'Notas 1-3',
    positive: 'Positivas',
    dist: 'Distribuicao de notas',
    pos_vs_crit: 'Positivas (4-5*): {p} ({pp})     -     Criticas (1-3*): {c} ({cp})',
    sentiment: 'Sentimento',
    sent_pos: 'POSITIVO',
    sent_neu: 'NEUTRO',
    sent_neg: 'NEGATIVO',
    themes: 'Temas registrados pela IA',
    vision_rei: 'Visao consolidada (Rei)',
    bottlenecks: 'Gargalos / temas mais citados',
    empty: 'Nenhuma avaliacao valida neste periodo. O relatorio continua disponivel; os numeros sobem com novos feedbacks.',
    ranking: 'Ranking de unidades',
    unit: 'Unidade',
    volume_col: 'Volume',
    avg_col: 'Media',
    crit_col: 'Criticas',
    branch: 'Demonstrativo',
    dist_unit: 'Distribuicao na unidade',
    themes_unit: 'Temas nesta unidade',
    page: 'Pagina {n} de {t}',
    total: 'total',
    positives: 'Positivas',
    critiques: 'Criticas',
    total_label: 'Total',
    benefits_pro: 'Plano Pro: KPIs do periodo, distribuicao 1*-5* e comparativo positivas vs criticas.',
    benefits_ultra: 'Plano Ultra: KPIs, distribuicao de notas, sentimento e temas detectados pela IA.',
    benefits_corp: 'Plano Corporativo: KPIs, distribuicao, temas IA, ranking de unidades e demonstrativo por filial.',
    benefits_rei: 'Plano Rei: KPIs, distribuicao, sentimento, temas IA, donut, gargalos, ranking e pagina por filial.',
    this_period: 'Neste periodo',
  },
  en: {
    subtitle: 'Monthly reputation report',
    badge_pro: 'Essential',
    badge_ultra: 'With AI',
    badge_corp: 'Multi-location',
    badge_rei: 'Full - King',
    period: 'Period',
    plan: 'Plan',
    summary: 'Period summary',
    volume: 'Volume',
    volume_sub: 'Valid reviews',
    avg: 'Average rating',
    avg_sub: 'Scale 1 to 5',
    critical: 'Critical',
    critical_sub: 'Ratings 1-3',
    positive: 'Positive',
    dist: 'Rating distribution',
    pos_vs_crit: 'Positive (4-5*): {p} ({pp})     -     Critical (1-3*): {c} ({cp})',
    sentiment: 'Sentiment',
    sent_pos: 'POSITIVE',
    sent_neu: 'NEUTRAL',
    sent_neg: 'NEGATIVE',
    themes: 'Themes detected by AI',
    vision_rei: 'Consolidated view (King)',
    bottlenecks: 'Bottlenecks / top themes',
    empty: 'No valid reviews in this period. The report remains available; numbers rise as feedback arrives.',
    ranking: 'Location ranking',
    unit: 'Location',
    volume_col: 'Volume',
    avg_col: 'Avg',
    crit_col: 'Critical',
    branch: 'Breakdown',
    dist_unit: 'Distribution at location',
    themes_unit: 'Themes at this location',
    page: 'Page {n} of {t}',
    total: 'total',
    positives: 'Positive',
    critiques: 'Critical',
    total_label: 'Total',
    benefits_pro: 'Pro plan: period KPIs, 1*-5* distribution and positive vs critical comparison.',
    benefits_ultra: 'Ultra plan: KPIs, rating distribution, sentiment and AI-detected themes.',
    benefits_corp: 'Corporate plan: KPIs, distribution, AI themes, location ranking and per-branch pages.',
    benefits_rei: 'King plan: KPIs, distribution, sentiment, AI themes, donut, bottlenecks, ranking and branch pages.',
    this_period: 'This period',
  },
  es: {
    subtitle: 'Informe mensual de reputacion',
    badge_pro: 'Esencial',
    badge_ultra: 'Con IA',
    badge_corp: 'Multi-sede',
    badge_rei: 'Completo - Rey',
    period: 'Periodo',
    plan: 'Plan',
    summary: 'Resumen del periodo',
    volume: 'Volumen',
    volume_sub: 'Evaluaciones validas',
    avg: 'Nota media',
    avg_sub: 'Escala 1 a 5',
    critical: 'Criticas',
    critical_sub: 'Notas 1-3',
    positive: 'Positivas',
    dist: 'Distribucion de notas',
    pos_vs_crit: 'Positivas (4-5*): {p} ({pp})     -     Criticas (1-3*): {c} ({cp})',
    sentiment: 'Sentimiento',
    sent_pos: 'POSITIVO',
    sent_neu: 'NEUTRO',
    sent_neg: 'NEGATIVO',
    themes: 'Temas detectados por la IA',
    vision_rei: 'Vision consolidada (Rey)',
    bottlenecks: 'Cuellos de botella / temas mas citados',
    empty: 'Ninguna evaluacion valida en este periodo. El informe sigue disponible; los numeros suben con nuevos feedbacks.',
    ranking: 'Ranking de unidades',
    unit: 'Unidad',
    volume_col: 'Volumen',
    avg_col: 'Media',
    crit_col: 'Criticas',
    branch: 'Demostrativo',
    dist_unit: 'Distribucion en la unidad',
    themes_unit: 'Temas en esta unidad',
    page: 'Pagina {n} de {t}',
    total: 'total',
    positives: 'Positivas',
    critiques: 'Criticas',
    total_label: 'Total',
    benefits_pro: 'Plan Pro: KPIs del periodo, distribucion 1*-5* y comparativo positivas vs criticas.',
    benefits_ultra: 'Plan Ultra: KPIs, distribucion de notas, sentimiento y temas de la IA.',
    benefits_corp: 'Plan Corporativo: KPIs, distribucion, temas IA, ranking y pagina por sede.',
    benefits_rei: 'Plan Rey: KPIs, distribucion, sentimiento, temas IA, donut, gargalos, ranking y paginas por sede.',
    this_period: 'En este periodo',
  },
  zh: {
    subtitle: 'Monthly reputation report',
    badge_pro: 'Essential',
    badge_ultra: 'With AI',
    badge_corp: 'Multi-location',
    badge_rei: 'Full - King',
    period: 'Period',
    plan: 'Plan',
    summary: 'Period summary',
    volume: 'Volume',
    volume_sub: 'Valid reviews',
    avg: 'Average',
    avg_sub: 'Scale 1-5',
    critical: 'Critical',
    critical_sub: 'Ratings 1-3',
    positive: 'Positive',
    dist: 'Rating distribution',
    pos_vs_crit: 'Positive (4-5*): {p} ({pp})     -     Critical (1-3*): {c} ({cp})',
    sentiment: 'Sentiment',
    sent_pos: 'POSITIVE',
    sent_neu: 'NEUTRAL',
    sent_neg: 'NEGATIVE',
    themes: 'AI themes',
    vision_rei: 'Consolidated (King)',
    bottlenecks: 'Top themes',
    empty: 'No valid reviews this period.',
    ranking: 'Location ranking',
    unit: 'Location',
    volume_col: 'Volume',
    avg_col: 'Avg',
    crit_col: 'Critical',
    branch: 'Breakdown',
    dist_unit: 'Distribution',
    themes_unit: 'Themes',
    page: 'Page {n} of {t}',
    total: 'total',
    positives: 'Positive',
    critiques: 'Critical',
    total_label: 'Total',
    benefits_pro: 'Pro: KPIs and 1*-5* distribution.',
    benefits_ultra: 'Ultra: KPIs, sentiment and AI themes.',
    benefits_corp: 'Corporate: ranking and branch pages.',
    benefits_rei: 'King: full report with branch pages.',
    this_period: 'This period',
  },
};

/**
 * Chinês: Helvetica não renderiza CJK. Usamos rótulos em inglês legíveis
 * até haver fonte CJK embutida (PDF_FONT_CJK). Os textos acima em zh
 * estão em ASCII de propósito para não virar "&".
 */
export function t(lang: PdfLang, key: string, vars?: Record<string, string | number>): string {
  const dict = T[lang] || T.pt;
  let s = dict[key] || T.pt[key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return s;
}

export function benefitsFor(depth: string, lang: PdfLang): string {
  if (depth === 'rei') return t(lang, 'benefits_rei');
  if (depth === 'corp') return t(lang, 'benefits_corp');
  if (depth === 'ultra') return t(lang, 'benefits_ultra');
  return t(lang, 'benefits_pro');
}

export function badgeFor(depth: string, lang: PdfLang): string {
  if (depth === 'rei') return t(lang, 'badge_rei');
  if (depth === 'corp') return t(lang, 'badge_corp');
  if (depth === 'ultra') return t(lang, 'badge_ultra');
  return t(lang, 'badge_pro');
}
