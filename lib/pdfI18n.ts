/** Textos do relatório PDF — pt | en | es | zh */

export type PdfLang = 'pt' | 'en' | 'es' | 'zh';
export type PdfDepth = 'pro' | 'ultra' | 'corp' | 'rei';

export function normalizePdfLang(raw?: string | null): PdfLang {
  const s = String(raw || 'pt').toLowerCase().trim();
  if (s.startsWith('en')) return 'en';
  if (s.startsWith('es') || s.startsWith('spa')) return 'es';
  if (s.startsWith('zh') || s.startsWith('cn') || s.includes('chinese') || s === '中文') return 'zh';
  return 'pt';
}

const MONTHS: Record<PdfLang, string[]> = {
  pt: ['Janeiro','Fevereiro','Marco','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'],
  en: ['January','February','March','April','May','June','July','August','September','October','November','December'],
  es: ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'],
  zh: ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'],
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
    badge_pro: 'Pro - Essencial',
    badge_ultra: 'Ultra - Com IA',
    badge_corp: 'Corporativo - Multi-unidade',
    badge_rei: 'Rei - Completo',
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
    sentiment: 'Sentimento (IA)',
    sent_pos: 'POSITIVO',
    sent_neu: 'NEUTRO',
    sent_neg: 'NEGATIVO',
    themes: 'Temas detectados pela IA',
    vision_rei: 'Visao consolidada (exclusivo Rei)',
    bottlenecks: 'Gargalos / temas mais citados',
    empty: 'Nenhuma avaliacao valida neste periodo. Os numeros sobem com novos feedbacks.',
    ranking: 'Ranking de unidades (Corporativo/Rei)',
    unit: 'Unidade',
    volume_col: 'Volume',
    avg_col: 'Media',
    crit_col: 'Criticas',
    branch: 'Demonstrativo filial',
    dist_unit: 'Distribuicao na unidade',
    themes_unit: 'Temas nesta unidade',
    page: 'Pagina {n} de {t}',
    total: 'total',
    positives: 'Positivas',
    critiques: 'Criticas',
    total_label: 'Total',
    this_period: 'Neste periodo',
    benefits_title: 'O que este plano inclui neste relatorio',
    locked_title: 'Disponivel em planos superiores',
    benefits_pro: 'Plano Pro: KPIs, distribuicao 1*-5* e comparativo positivas vs criticas.',
    benefits_ultra: 'Plano Ultra: tudo do Pro + sentimento e temas da IA.',
    benefits_corp: 'Plano Corporativo: tudo do Ultra + ranking e pagina por filial.',
    benefits_rei: 'Plano Rei: relatorio completo com donut, gargalos e filiais detalhadas.',
    no_units: 'Nenhuma filial cadastrada. Cadastre unidades no painel para ver ranking e demonstrativos.',
  },
  en: {
    subtitle: 'Monthly reputation report',
    badge_pro: 'Pro - Essential',
    badge_ultra: 'Ultra - With AI',
    badge_corp: 'Corporate - Multi-location',
    badge_rei: 'King - Full',
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
    sentiment: 'Sentiment (AI)',
    sent_pos: 'POSITIVE',
    sent_neu: 'NEUTRAL',
    sent_neg: 'NEGATIVE',
    themes: 'Themes detected by AI',
    vision_rei: 'Consolidated view (King only)',
    bottlenecks: 'Bottlenecks / top themes',
    empty: 'No valid reviews in this period.',
    ranking: 'Location ranking (Corporate/King)',
    unit: 'Location',
    volume_col: 'Volume',
    avg_col: 'Avg',
    crit_col: 'Critical',
    branch: 'Branch breakdown',
    dist_unit: 'Distribution at location',
    themes_unit: 'Themes at this location',
    page: 'Page {n} of {t}',
    total: 'total',
    positives: 'Positive',
    critiques: 'Critical',
    total_label: 'Total',
    this_period: 'This period',
    benefits_title: 'What this plan includes in this report',
    locked_title: 'Available on higher plans',
    benefits_pro: 'Pro: KPIs, 1*-5* distribution and positive vs critical.',
    benefits_ultra: 'Ultra: Pro + sentiment and AI themes.',
    benefits_corp: 'Corporate: Ultra + ranking and per-branch pages.',
    benefits_rei: 'King: full report with donut, bottlenecks and branch detail.',
    no_units: 'No branches registered. Add locations in the panel to unlock ranking pages.',
  },
  es: {
    subtitle: 'Informe mensual de reputacion',
    badge_pro: 'Pro - Esencial',
    badge_ultra: 'Ultra - Con IA',
    badge_corp: 'Corporativo - Multi-sede',
    badge_rei: 'Rey - Completo',
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
    sentiment: 'Sentimiento (IA)',
    sent_pos: 'POSITIVO',
    sent_neu: 'NEUTRO',
    sent_neg: 'NEGATIVO',
    themes: 'Temas detectados por la IA',
    vision_rei: 'Vision consolidada (solo Rey)',
    bottlenecks: 'Cuellos de botella / temas mas citados',
    empty: 'Ninguna evaluacion valida en este periodo.',
    ranking: 'Ranking de unidades (Corporativo/Rey)',
    unit: 'Unidad',
    volume_col: 'Volumen',
    avg_col: 'Media',
    crit_col: 'Criticas',
    branch: 'Demostrativo sede',
    dist_unit: 'Distribucion en la unidad',
    themes_unit: 'Temas en esta unidad',
    page: 'Pagina {n} de {t}',
    total: 'total',
    positives: 'Positivas',
    critiques: 'Criticas',
    total_label: 'Total',
    this_period: 'En este periodo',
    benefits_title: 'Lo que incluye este plan en el informe',
    locked_title: 'Disponible en planes superiores',
    benefits_pro: 'Pro: KPIs, distribucion 1*-5* y positivas vs criticas.',
    benefits_ultra: 'Ultra: Pro + sentimiento y temas IA.',
    benefits_corp: 'Corporativo: Ultra + ranking y paginas por sede.',
    benefits_rei: 'Rey: informe completo con donut, gargalos y sedes.',
    no_units: 'No hay sedes registradas. Agregue unidades en el panel.',
  },
  zh: {
    subtitle: 'Monthly reputation report',
    badge_pro: 'Pro - Essential',
    badge_ultra: 'Ultra - With AI',
    badge_corp: 'Corporate - Multi-location',
    badge_rei: 'King - Full',
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
    sentiment: 'Sentiment (AI)',
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
    this_period: 'This period',
    benefits_title: 'Included in this plan report',
    locked_title: 'Higher plans only',
    benefits_pro: 'Pro: KPIs and distribution.',
    benefits_ultra: 'Ultra: Pro + AI sentiment/themes.',
    benefits_corp: 'Corporate: Ultra + branches.',
    benefits_rei: 'King: full report.',
    no_units: 'No branches registered.',
  },
};

/** Itens incluídos por profundidade do plano (ordem crescente). */
const FEATURES: Record<PdfLang, { id: string; label: string; min: PdfDepth }[]> = {
  pt: [
    { id: 'kpi', label: 'KPIs (volume, media, criticas, positivas)', min: 'pro' },
    { id: 'dist', label: 'Distribuicao de notas 1* a 5*', min: 'pro' },
    { id: 'cmp', label: 'Comparativo positivas vs criticas', min: 'pro' },
    { id: 'sent', label: 'Analise de sentimento (IA)', min: 'ultra' },
    { id: 'tags', label: 'Temas detectados pela IA', min: 'ultra' },
    { id: 'rank', label: 'Ranking de unidades / filiais', min: 'corp' },
    { id: 'branch', label: 'Pagina demonstrativa por filial', min: 'corp' },
    { id: 'donut', label: 'Visao consolidada com grafico donut', min: 'rei' },
    { id: 'gap', label: 'Gargalos e temas mais citados', min: 'rei' },
    { id: 'rich', label: 'Demonstrativo rico por filial (Rei)', min: 'rei' },
  ],
  en: [
    { id: 'kpi', label: 'KPIs (volume, average, critical, positive)', min: 'pro' },
    { id: 'dist', label: 'Rating distribution 1* to 5*', min: 'pro' },
    { id: 'cmp', label: 'Positive vs critical comparison', min: 'pro' },
    { id: 'sent', label: 'Sentiment analysis (AI)', min: 'ultra' },
    { id: 'tags', label: 'AI-detected themes', min: 'ultra' },
    { id: 'rank', label: 'Location ranking', min: 'corp' },
    { id: 'branch', label: 'Per-branch breakdown pages', min: 'corp' },
    { id: 'donut', label: 'Consolidated donut chart', min: 'rei' },
    { id: 'gap', label: 'Bottlenecks / top themes', min: 'rei' },
    { id: 'rich', label: 'Rich per-branch detail (King)', min: 'rei' },
  ],
  es: [
    { id: 'kpi', label: 'KPIs (volumen, media, criticas, positivas)', min: 'pro' },
    { id: 'dist', label: 'Distribucion de notas 1* a 5*', min: 'pro' },
    { id: 'cmp', label: 'Comparativo positivas vs criticas', min: 'pro' },
    { id: 'sent', label: 'Analisis de sentimiento (IA)', min: 'ultra' },
    { id: 'tags', label: 'Temas detectados por la IA', min: 'ultra' },
    { id: 'rank', label: 'Ranking de unidades', min: 'corp' },
    { id: 'branch', label: 'Pagina por sede', min: 'corp' },
    { id: 'donut', label: 'Grafico donut consolidado', min: 'rei' },
    { id: 'gap', label: 'Cuellos de botella / temas top', min: 'rei' },
    { id: 'rich', label: 'Detalle rico por sede (Rey)', min: 'rei' },
  ],
  zh: [
    { id: 'kpi', label: 'KPIs', min: 'pro' },
    { id: 'dist', label: 'Rating distribution 1*-5*', min: 'pro' },
    { id: 'cmp', label: 'Positive vs critical', min: 'pro' },
    { id: 'sent', label: 'Sentiment (AI)', min: 'ultra' },
    { id: 'tags', label: 'AI themes', min: 'ultra' },
    { id: 'rank', label: 'Location ranking', min: 'corp' },
    { id: 'branch', label: 'Branch pages', min: 'corp' },
    { id: 'donut', label: 'Donut chart', min: 'rei' },
    { id: 'gap', label: 'Top themes', min: 'rei' },
    { id: 'rich', label: 'Rich branch detail', min: 'rei' },
  ],
};

const DEPTH_RANK: Record<PdfDepth, number> = { pro: 1, ultra: 2, corp: 3, rei: 4 };

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

/** Lista de recursos com flag included para desenhar no PDF. */
export function featureChecklist(
  depth: PdfDepth,
  lang: PdfLang
): { label: string; included: boolean }[] {
  const rank = DEPTH_RANK[depth] || 1;
  const list = FEATURES[lang] || FEATURES.pt;
  return list.map((f) => ({
    label: f.label,
    included: rank >= (DEPTH_RANK[f.min] || 1),
  }));
}
