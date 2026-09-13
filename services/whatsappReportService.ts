/** Relatório WhatsApp: resumo determinístico dos dados do painel, sem IA e com cache. */
import crypto from 'crypto';
import type { Database } from 'sqlite';

export type ReportPeriod = { tipo: 'semana' | 'mes'; inicio: string; fim: string; chave: string };
type Tier = 'inicial' | 'pro' | 'ultra' | 'corporativo' | 'rei';
type Data = { cliente_id: string; periodo_inicio: string; periodo_fim: string; score_medio: number | null; total_avaliacoes: number; variacao_score: number | null; score_anterior: number | null; estrelas: Record<string, number>; top_elogios: string[]; top_reclamacoes: string[]; tendencia: 'positiva' | 'negativa' | 'estavel' | 'sem_dados' };
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
    const x = iso(a), y = iso(b);
    return { tipo, inicio: x, fim: y, chave: `${x}_${y}` };
  }
  const n = new Date();
  if (tipo === 'mes') {
    const a = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)), b = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0));
    const x = iso(a), y = iso(b); return { tipo, inicio: x, fim: y, chave: `${x}_${y}` };
  }
  const off = n.getUTCDay() === 0 ? -6 : 1 - n.getUTCDay();
  const a = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + off)), b = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + off + 6));
  const x = iso(a), y = iso(b); return { tipo, inicio: x, fim: y, chave: `${x}_${y}` };
}

export async function ensureReportCacheSchema(db: Database) {
  await db.exec(`CREATE TABLE IF NOT EXISTS relatorios_cache(id TEXT PRIMARY KEY,cliente_id TEXT NOT NULL,periodo_tipo TEXT NOT NULL,periodo_inicio TEXT NOT NULL,periodo_fim TEXT NOT NULL,chave_periodo TEXT NOT NULL,dados_hash TEXT,texto_relatorio TEXT,modelo_ia TEXT,status TEXT NOT NULL DEFAULT 'generating',generation_started_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(cliente_id,periodo_inicio,periodo_fim))`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_relatorios_cache_cliente ON relatorios_cache(cliente_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_relatorios_cache_periodo ON relatorios_cache(chave_periodo)`);
}

async function getCache(db: Database, id: string, p: ReportPeriod) { return db.get<CacheRow>(`SELECT cliente_id,periodo_tipo,periodo_inicio,periodo_fim,chave_periodo,dados_hash,texto_relatorio,modelo_ia,status,generation_started_at FROM relatorios_cache WHERE cliente_id=? AND periodo_inicio=? AND periodo_fim=?`, [id, p.inicio, p.fim]); }
function tags(v: unknown) { if (!v) return [] as string[]; try { const x = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(x) ? x.map(y => String(y || '').trim()).filter(Boolean).slice(0, 10) : []; } catch { return []; } }
function top(rows: Array<{ ai_tags?: unknown }>) { const c = new Map<string, number>(); for (const r of rows) for (const x of tags(r.ai_tags)) { const k = x.slice(0, 80); c.set(k, (c.get(k) || 0) + 1); } return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]); }

async function data(db: Database, id: string, p: ReportPeriod): Promise<Data> {
  const s = `${p.inicio}T00:00:00.000Z`, ed = new Date(`${p.fim}T00:00:00.000Z`); ed.setUTCDate(ed.getUTCDate() + 1); const e = ed.toISOString();
  const cur = await db.get<{ avg: number | null; total: number }>(`SELECT AVG(rating) avg,COUNT(*) total FROM reviews WHERE empresa_id=? AND createdAt>=? AND createdAt<? AND COALESCE(is_test,0)=0`, [id, s, e]);
  const pe = new Date(`${p.inicio}T00:00:00.000Z`), ps = new Date(pe.getTime() - (ed.getTime() - pe.getTime()));
  const prev = await db.get<{ avg: number | null }>(`SELECT AVG(rating) avg FROM reviews WHERE empresa_id=? AND createdAt>=? AND createdAt<? AND COALESCE(is_test,0)=0`, [id, ps.toISOString(), s]);
  const dist = await db.all<{ rating: number; total: number }>(`SELECT rating,COUNT(*) total FROM reviews WHERE empresa_id=? AND createdAt>=? AND createdAt<? AND COALESCE(is_test,0)=0 GROUP BY rating`, [id, s, e]);
  const all = await db.all<{ ai_tags?: string | null }>(`SELECT ai_tags FROM reviews WHERE empresa_id=? AND createdAt>=? AND createdAt<? AND COALESCE(is_test,0)=0 AND ai_tags IS NOT NULL ORDER BY createdAt DESC LIMIT 500`, [id, s, e]);
  const pos = await db.all<{ ai_tags?: string | null }>(`SELECT ai_tags FROM reviews WHERE empresa_id=? AND createdAt>=? AND createdAt<? AND COALESCE(is_test,0)=0 AND rating>=4 AND ai_tags IS NOT NULL ORDER BY createdAt DESC LIMIT 300`, [id, s, e]);
  const neg = await db.all<{ ai_tags?: string | null }>(`SELECT ai_tags FROM reviews WHERE empresa_id=? AND createdAt>=? AND createdAt<? AND COALESCE(is_test,0)=0 AND rating<=3 AND ai_tags IS NOT NULL ORDER BY createdAt DESC LIMIT 300`, [id, s, e]);
  const a = cur?.avg == null ? null : Number(cur.avg), o = prev?.avg == null ? null : Number(prev.avg);
  const estrelas: Record<string, number> = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 }; for (const r of dist) estrelas[String(r.rating)] = Number(r.total || 0);
  const variacao = a != null && o != null ? Number((a - o).toFixed(2)) : null;
  return { cliente_id: id, periodo_inicio: p.inicio, periodo_fim: p.fim, score_medio: a != null && Number.isFinite(a) ? Number(a.toFixed(2)) : null, total_avaliacoes: Number(cur?.total || 0), variacao_score: variacao, score_anterior: o != null && Number.isFinite(o) ? Number(o.toFixed(2)) : null, estrelas, top_elogios: top(pos.length ? pos : all), top_reclamacoes: top(neg), tendencia: a == null || o == null ? (Number(cur?.total || 0) ? 'estavel' : 'sem_dados') : variacao! > 0 ? 'positiva' : variacao! < 0 ? 'negativa' : 'estavel' };
}

function tier(plan: string | null | undefined): Tier { const p = String(plan || '').toLowerCase(); if (p === 'trial' || p === 'teste' || p === 'rei') return 'rei'; if (p === 'corporativo') return 'corporativo'; if (p === 'ultra') return 'ultra'; if (p === 'pro') return 'pro'; return 'inicial'; }
const n = (v: number) => v.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const stars = (d: Data) => `⭐ 5 estrelas: ${d.estrelas['5']}\n⭐ 4 estrelas: ${d.estrelas['4']}\n⭐ 3 estrelas: ${d.estrelas['3']}\n⭐ 2 estrelas: ${d.estrelas['2']}\n⭐ 1 estrela: ${d.estrelas['1']}`;

/**
 * Monta somente uma versão compacta dos dados existentes no painel.
 * Não cria diagnóstico, causa, recomendação, previsão ou informação externa.
 */
function text(d: Data, p: ReportPeriod, plan?: string | null) {
  const t = tier(plan), nomePlano = t === 'rei' ? 'Rei' : t.charAt(0).toUpperCase() + t.slice(1);
  const l: string[] = [`📊 *Relatório de Reputação — ${nomePlano}*`, `📅 *Período:* ${p.inicio} a ${p.fim}`, ''];

  if (d.score_medio != null) l.push(`⭐ *Nota média:* ${n(d.score_medio)}/5`);
  else l.push('⭐ *Nota média:* Sem dados no período');
  l.push(`💬 *Avaliações:* ${d.total_avaliacoes}`);

  if (d.variacao_score != null) l.push(`${d.variacao_score > 0 ? '📈' : d.variacao_score < 0 ? '📉' : '➡️'} *Variação da nota:* ${d.variacao_score > 0 ? '+' : ''}${n(d.variacao_score)}`);

  if (t !== 'inicial') l.push('', '*Distribuição das avaliações*', stars(d));

  if (t === 'ultra' || t === 'corporativo' || t === 'rei') {
    if (d.score_anterior != null) l.push('', `📊 *Nota do período anterior:* ${n(d.score_anterior)}/5`);
    if (d.tendencia !== 'sem_dados') l.push(`📌 *Variação registrada:* ${d.tendencia === 'positiva' ? 'positiva' : d.tendencia === 'negativa' ? 'negativa' : 'estável'}`);
  }

  if (t === 'pro' || t === 'ultra' || t === 'corporativo' || t === 'rei') {
    if (d.top_elogios.length) l.push('', '👍 *Principais elogios extraídos*', ...d.top_elogios.map(x => `• ${x}`));
    if (d.top_reclamacoes.length) l.push('', '⚠️ *Principais reclamações extraídas*', ...d.top_reclamacoes.map(x => `• ${x}`));
  }

  if (t === 'corporativo' || t === 'rei') {
    l.push('', '📋 *Resumo dos dados*');
    if (d.total_avaliacoes === 0) l.push('Nenhuma avaliação registrada no período.');
    else {
      if (d.top_elogios.length) l.push(`Elogios mais frequentes: ${d.top_elogios.slice(0, 3).join(', ')}.`);
      if (d.top_reclamacoes.length) l.push(`Reclamações mais frequentes: ${d.top_reclamacoes.slice(0, 3).join(', ')}.`);
      if (!d.top_elogios.length && !d.top_reclamacoes.length) l.push('Não há tags de elogios ou reclamações disponíveis no painel para este período.');
    }
  }

  return l.join('\n');
}

async function claim(db: Database, id: string, p: ReportPeriod) { const now = new Date().toISOString(), r = await db.run(`INSERT INTO relatorios_cache(id,cliente_id,periodo_tipo,periodo_inicio,periodo_fim,chave_periodo,status,generation_started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'generating',?,?,?) ON CONFLICT(cliente_id,periodo_inicio,periodo_fim) DO NOTHING`, [crypto.randomUUID(), id, p.tipo, p.inicio, p.fim, p.chave, now, now, now]); return Number(r.changes || 0) > 0; }
async function wait(db: Database, id: string, p: ReportPeriod) { for (let i = 0; i < WAIT_ATTEMPTS; i++) { await new Promise(r => setTimeout(r, WAIT_MS)); const x = await getCache(db, id, p); if (x?.status === 'ready' && x.texto_relatorio) return x; } return getCache(db, id, p); }
async function recover(db: Database, row: CacheRow, p: ReportPeriod) { const t = Date.parse(row.generation_started_at || ''); if (row.status === 'generating' && Number.isFinite(t) && Date.now() - t > GENERATION_TIMEOUT_MS) await db.run(`DELETE FROM relatorios_cache WHERE cliente_id=? AND periodo_inicio=? AND periodo_fim=? AND status='generating'`, [row.cliente_id, p.inicio, p.fim]); }

export async function getOrGenerateWhatsAppReport(db: Database, id: string, p: ReportPeriod, plan?: string | null): Promise<{ text: string; cached: boolean; model: string; data: Data }> {
  await ensureReportCacheSchema(db);
  let r = await getCache(db, id, p);
  if (r?.status === 'ready' && r.texto_relatorio) return { text: r.texto_relatorio, cached: true, model: 'none', data: {} as Data };
  if (r?.status === 'generating') { await recover(db, r, p); r = await getCache(db, id, p); if (r?.status === 'generating') { const x = await wait(db, id, p); if (x?.status === 'ready' && x.texto_relatorio) return { text: x.texto_relatorio, cached: true, model: 'none', data: {} as Data }; throw Error('Geração do relatório já está em andamento. Tente novamente em instantes.'); } }
  if (!await claim(db, id, p)) { const x = await wait(db, id, p); if (x?.status === 'ready' && x.texto_relatorio) return { text: x.texto_relatorio, cached: true, model: 'none', data: {} as Data }; throw Error('Geração do relatório já está em andamento. Tente novamente em instantes.'); }
  try { const d = await data(db, id, p), t = text(d, p, plan), h = crypto.createHash('sha256').update(JSON.stringify({ ...d, plan: tier(plan) })).digest('hex'); await db.run(`UPDATE relatorios_cache SET dados_hash=?,texto_relatorio=?,modelo_ia='none',status='ready',updated_at=? WHERE cliente_id=? AND periodo_inicio=? AND periodo_fim=?`, [h, t, new Date().toISOString(), id, p.inicio, p.fim]); return { text: t, cached: false, model: 'none', data: d }; } catch (e) { await db.run(`DELETE FROM relatorios_cache WHERE cliente_id=? AND periodo_inicio=? AND periodo_fim=? AND status='generating'`, [id, p.inicio, p.fim]); throw e; }
}
