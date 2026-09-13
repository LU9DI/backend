/** Relatório WhatsApp: resumo determinístico dos dados já processados pelo painel, sem IA. */
import crypto from 'crypto';
import type { Database } from 'sqlite';

export type ReportPeriod = { tipo: 'semana' | 'mes'; inicio: string; fim: string; chave: string };
type Tier = 'inicial' | 'pro' | 'ultra' | 'corporativo' | 'rei';
type Sentimento = { positivo: number; neutro: number; negativo: number };
type Tag = { tag: string; count: number };
type Data = {
  cliente_id: string; periodo_inicio: string; periodo_fim: string;
  score_medio: number | null; total_avaliacoes: number;
  variacao_score: number | null; score_anterior: number | null;
  estrelas: Record<string, number>; positivas: number; negativas: number;
  tratadas: number; pendentes_tratamento: number; taxa_positiva: number;
  crises_24h: number; sentimento_mix: Sentimento; sentimento_score_medio: number | null;
  top_tags: Tag[]; top_elogios: Tag[]; top_alertas: Tag[];
  tendencia: 'positiva' | 'negativa' | 'estavel' | 'sem_dados';
};
type CacheRow = { cliente_id: string; periodo_tipo: string; periodo_inicio: string; periodo_fim: string; chave_periodo: string; dados_hash: string | null; texto_relatorio: string | null; modelo_ia: string | null; status: string; generation_started_at: string | null };

const GENERATION_TIMEOUT_MS = 600000, WAIT_MS = 250, WAIT_ATTEMPTS = 40;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00.000Z`) : null;

export function buildReportPeriod(t?: string | null, i?: string | null, f?: string | null): ReportPeriod {
  const tipo = String(t || 'semana').toLowerCase() === 'mes' ? 'mes' : 'semana';
  if (i || f) {
    if (!i || !f) throw Error('Informe inicio e fim do período.');
    const a = parse(i), b = parse(f);
    if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a > b) throw Error('Período inválido. Use datas YYYY-MM-DD.');
    if (b.getTime() - a.getTime() > 366 * 86400000) throw Error('Período máximo permitido: 366 dias.');
    const x = iso(a), y = iso(b); return { tipo, inicio: x, fim: y, chave: `${x}_${y}` };
  }
  const n = new Date();
  if (tipo === 'mes') {
    const a = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
    const b = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0));
    const x = iso(a), y = iso(b); return { tipo, inicio: x, fim: y, chave: `${x}_${y}` };
  }
  const off = n.getUTCDay() === 0 ? -6 : 1 - n.getUTCDay();
  const a = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + off));
  const b = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + off + 6));
  const x = iso(a), y = iso(b); return { tipo, inicio: x, fim: y, chave: `${x}_${y}` };
}

export async function ensureReportCacheSchema(db: Database) {
  await db.exec(`CREATE TABLE IF NOT EXISTS relatorios_cache(id TEXT PRIMARY KEY,cliente_id TEXT NOT NULL,periodo_tipo TEXT NOT NULL,periodo_inicio TEXT NOT NULL,periodo_fim TEXT NOT NULL,chave_periodo TEXT NOT NULL,dados_hash TEXT,texto_relatorio TEXT,modelo_ia TEXT,status TEXT NOT NULL DEFAULT 'generating',generation_started_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(cliente_id,periodo_inicio,periodo_fim))`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_relatorios_cache_cliente ON relatorios_cache(cliente_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_relatorios_cache_periodo ON relatorios_cache(chave_periodo)`);
}

async function getCache(db: Database, id: string, p: ReportPeriod) {
  return db.get<CacheRow>(`SELECT cliente_id,periodo_tipo,periodo_inicio,periodo_fim,chave_periodo,dados_hash,texto_relatorio,modelo_ia,status,generation_started_at FROM relatorios_cache WHERE cliente_id=? AND periodo_inicio=? AND periodo_fim=?`, [id, p.inicio, p.fim]);
}
function parseTags(v: unknown): string[] {
  if (!v) return [];
  try { const x = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(x) ? x.map(y => String(y || '').trim()).filter(Boolean) : []; } catch { return []; }
}
function aggregateTags(rows: Array<{ ai_tags?: unknown }>, predicate: (r: any) => boolean): Tag[] {
  const c = new Map<string, number>();
  for (const r of rows) if (predicate(r)) for (const raw of parseTags(r.ai_tags)) {
    const tag = raw.slice(0, 80); if (tag) c.set(tag, (c.get(tag) || 0) + 1);
  }
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([tag, count]) => ({ tag, count }));
}

async function data(db: Database, id: string, p: ReportPeriod): Promise<Data> {
  const start = `${p.inicio}T00:00:00.000Z`;
  const endDate = new Date(`${p.fim}T00:00:00.000Z`); endDate.setUTCDate(endDate.getUTCDate() + 1);
  const end = endDate.toISOString();
  const rows = await db.all<any>(`SELECT rating, ai_tags, sentiment, sentiment_score, createdAt, treated_at FROM reviews WHERE empresa_id=? AND createdAt>=? AND createdAt<? AND COALESCE(is_test,0)=0`, [id, start, end]);
  const current = rows || [];
  const periodMs = endDate.getTime() - new Date(start).getTime();
  const prevStart = new Date(new Date(start).getTime() - periodMs).toISOString();
  const previous = await db.get<{ avg: number | null }>(`SELECT AVG(rating) avg FROM reviews WHERE empresa_id=? AND createdAt>=? AND createdAt<? AND COALESCE(is_test,0)=0`, [id, prevStart, start]);
  const total = current.length;
  const avg = total ? Math.round((current.reduce((s: number, r: any) => s + Number(r.rating || 0), 0) / total) * 10) / 10 : null;
  const prevAvg = previous?.avg == null ? null : Number(Number(previous.avg).toFixed(1));
  const estrelas: Record<string, number> = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 };
  for (const r of current) { const rating = Number(r.rating); if (rating >= 1 && rating <= 5) estrelas[String(rating)] += 1; }
  const positivas = current.filter((r: any) => Number(r.rating) >= 4).length;
  const negativas = current.filter((r: any) => Number(r.rating) <= 3).length;
  const tratadas = current.filter((r: any) => Number(r.rating) <= 3 && Boolean(r.treated_at)).length;
  const sentimento_mix: Sentimento = { positivo: 0, neutro: 0, negativo: 0 };
  let sentimentSum = 0, sentimentN = 0;
  for (const r of current) {
    const label = String(r.sentiment || '').toLowerCase();
    if (label === 'positivo') sentimento_mix.positivo++;
    else if (label === 'negativo') sentimento_mix.negativo++;
    else if (label === 'neutro') sentimento_mix.neutro++;
    else if (Number(r.rating) >= 4) sentimento_mix.positivo++;
    else if (Number(r.rating) <= 2) sentimento_mix.negativo++;
    else sentimento_mix.neutro++;
    if (r.sentiment_score != null && Number.isFinite(Number(r.sentiment_score))) { sentimentSum += Number(r.sentiment_score); sentimentN++; }
  }
  const crises_24h = current.filter((r: any) => Number(r.rating) <= 2 && new Date(r.createdAt).getTime() >= Date.now() - 86400000).length;
  const variation = avg != null && prevAvg != null ? Number((avg - prevAvg).toFixed(1)) : null;
  const top_elogios = aggregateTags(current, r => Number(r.rating) >= 4);
  const top_alertas = aggregateTags(current, r => Number(r.rating) <= 3);
  const top_tags = aggregateTags(current, () => true);
  return { cliente_id: id, periodo_inicio: p.inicio, periodo_fim: p.fim, score_medio: avg, total_avaliacoes: total, variacao_score: variation, score_anterior: prevAvg, estrelas, positivas, negativas, tratadas, pendentes_tratamento: Math.max(0, negativas - tratadas), taxa_positiva: total ? Math.round((positivas / total) * 100) : 0, crises_24h, sentimento_mix, sentimento_score_medio: sentimentN ? Math.round((sentimentSum / sentimentN) * 100) / 100 : null, top_tags, top_elogios, top_alertas, tendencia: avg == null || prevAvg == null ? (total ? 'estavel' : 'sem_dados') : variation! > 0 ? 'positiva' : variation! < 0 ? 'negativa' : 'estavel' };
}

function tier(plan: string | null | undefined): Tier {
  const p = String(plan || '').toLowerCase();
  if (p === 'trial' || p === 'teste' || p === 'rei') return 'rei';
  if (p === 'corporativo') return 'corporativo';
  if (p === 'ultra') return 'ultra';
  if (p === 'pro') return 'pro';
  return 'inicial';
}
const n = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const pct = (v: number, total: number) => total ? Math.round(v / total * 100) : 0;
function tags(lines: string[], title: string, items: Tag[], icon: string) { if (items.length) lines.push('', `${icon} *${title}*`, ...items.slice(0, 3).map(x => `• ${x.tag} (${x.count})`)); }

function text(d: Data, p: ReportPeriod, plan?: string | null) {
  const t = tier(plan);
  const name = t === 'rei' ? 'Rei' : t.charAt(0).toUpperCase() + t.slice(1);
  const lines: string[] = [`📊 *Filtra.IA — Resumo da Reputação*`, `📌 *Plano:* ${name}`, `📅 *Período:* ${p.inicio} a ${p.fim}`, '', `⭐ *Nota média:* ${d.score_medio != null ? `${n(d.score_medio)}/5` : 'Sem avaliações'}`, `💬 *Novas avaliações:* ${d.total_avaliacoes}`];
  if (t === 'pro' || t === 'ultra' || t === 'corporativo' || t === 'rei') {
    if (d.variacao_score != null) lines.push(`📈 *Variação:* ${d.variacao_score > 0 ? '+' : ''}${n(d.variacao_score)} vs. período anterior`);
    const pos = pct(d.sentimento_mix.positivo, d.total_avaliacoes), neu = pct(d.sentimento_mix.neutro, d.total_avaliacoes), neg = pct(d.sentimento_mix.negativo, d.total_avaliacoes);
    lines.push(`🟢 *Sentimento:* ${pos}% positivo | ${neu}% neutro | ${neg}% negativo`);
    tags(lines, 'Destaques da semana', d.top_elogios, '👍');
    tags(lines, 'Pontos de atenção', d.top_alertas, '⚠️');
  }
  if (t === 'ultra' || t === 'corporativo' || t === 'rei') {
    lines.push('', '*Distribuição das avaliações*', `⭐ 5 estrelas: ${d.estrelas['5']}`, `⭐ 4 estrelas: ${d.estrelas['4']}`, `⭐ 3 estrelas: ${d.estrelas['3']}`, `⭐ 2 estrelas: ${d.estrelas['2']}`, `⭐ 1 estrela: ${d.estrelas['1']}`);
    if (d.sentimento_score_medio != null) lines.push(`📊 *Score médio de sentimento:* ${n(d.sentimento_score_medio)}`);
  }
  if (t === 'corporativo' || t === 'rei') {
    lines.push('', '*Status operacional*', `🛠️ *Avaliações negativas tratadas:* ${d.tratadas}`, `⏳ *Pendentes de tratamento:* ${d.pendentes_tratamento}`);
    if (d.crises_24h > 0) lines.push(`🚨 *Avaliações críticas nas últimas 24h:* ${d.crises_24h}`);
  }
  if (t === 'rei') {
    if (d.score_anterior != null) lines.push(`📊 *Nota do período anterior:* ${n(d.score_anterior)}/5`);
    if (d.top_tags.length) lines.push('', '*Principais temas identificados no painel*', ...d.top_tags.slice(0, 5).map(x => `• ${x.tag} (${x.count})`));
    if (d.total_avaliacoes > 0) {
      const ordered = Object.entries(d.estrelas).sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]));
      lines.push(`📌 *Maior concentração:* ${ordered[0][0]} estrelas (${ordered[0][1]} avaliações)`);
    }
  }
  return lines.join('\n');
}

async function claim(db: Database, id: string, p: ReportPeriod) {
  const now = new Date().toISOString();
  const r = await db.run(`INSERT INTO relatorios_cache(id,cliente_id,periodo_tipo,periodo_inicio,periodo_fim,chave_periodo,status,generation_started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'generating',?,?,?) ON CONFLICT(cliente_id,periodo_inicio,periodo_fim) DO NOTHING`, [crypto.randomUUID(), id, p.tipo, p.inicio, p.fim, p.chave, now, now, now]);
  return Number(r.changes || 0) > 0;
}
async function wait(db: Database, id: string, p: ReportPeriod) { for (let i = 0; i < WAIT_ATTEMPTS; i++) { await new Promise(r => setTimeout(r, WAIT_MS)); const x = await getCache(db, id, p); if (x?.status === 'ready' && x.texto_relatorio) return x; } return getCache(db, id, p); }
async function recover(db: Database, row: CacheRow, p: ReportPeriod) { const t = Date.parse(row.generation_started_at || ''); if (row.status === 'generating' && Number.isFinite(t) && Date.now() - t > GENERATION_TIMEOUT_MS) await db.run(`DELETE FROM relatorios_cache WHERE cliente_id=? AND periodo_inicio=? AND periodo_fim=? AND status='generating'`, [row.cliente_id, p.inicio, p.fim]); }

function cacheMatchesTier(row: CacheRow | undefined, plan?: string | null): boolean {
  return Boolean(row?.status === 'ready' && row.texto_relatorio && row.dados_hash?.startsWith(`${tier(plan)}:`));
}

export async function getOrGenerateWhatsAppReport(db: Database, id: string, p: ReportPeriod, plan?: string | null): Promise<{ text: string; cached: boolean; model: string; data: Data }> {
  await ensureReportCacheSchema(db);
  const currentTier = tier(plan);
  let r = await getCache(db, id, p);
  if (cacheMatchesTier(r, plan)) return { text: r!.texto_relatorio!, cached: true, model: 'none', data: {} as Data };
  if (r?.status === 'ready' && r.texto_relatorio && r.dados_hash && !r.dados_hash.startsWith(`${currentTier}:`)) {
    await db.run(`DELETE FROM relatorios_cache WHERE cliente_id=? AND periodo_inicio=? AND periodo_fim=? AND status='ready'`, [id, p.inicio, p.fim]);
    r = await getCache(db, id, p);
  }
  if (r?.status === 'generating') { await recover(db, r, p); r = await getCache(db, id, p); if (r?.status === 'generating') { const x = await wait(db, id, p); if (cacheMatchesTier(x, plan)) return { text: x!.texto_relatorio!, cached: true, model: 'none', data: {} as Data }; throw Error('Geração do relatório já está em andamento. Tente novamente em instantes.'); } }
  if (!await claim(db, id, p)) { const x = await wait(db, id, p); if (cacheMatchesTier(x, plan)) return { text: x!.texto_relatorio!, cached: true, model: 'none', data: {} as Data }; throw Error('Geração do relatório já está em andamento. Tente novamente em instantes.'); }
  try {
    const d = await data(db, id, p);
    const t = text(d, p, plan);
    const digest = crypto.createHash('sha256').update(JSON.stringify({ ...d, tier: currentTier })).digest('hex');
    const h = `${currentTier}:${digest}`;
    await db.run(`UPDATE relatorios_cache SET dados_hash=?,texto_relatorio=?,modelo_ia='none',status='ready',updated_at=? WHERE cliente_id=? AND periodo_inicio=? AND periodo_fim=?`, [h, t, new Date().toISOString(), id, p.inicio, p.fim]);
    return { text: t, cached: false, model: 'none', data: d };
  } catch (e) {
    await db.run(`DELETE FROM relatorios_cache WHERE cliente_id=? AND periodo_inicio=? AND periodo_fim=? AND status='generating'`, [id, p.inicio, p.fim]);
    throw e;
  }
}
