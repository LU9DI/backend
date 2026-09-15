/** Relatório inteligente DETERMINÍSTICO (0 tokens de IA). */
import type { Database } from 'sqlite';
import { planLabel } from '../lib/plans.js';

export type RelatorioDestino = {
  canal: 'email' | 'whatsapp' | 'sms' | 'wechat';
  destino: string;
};

export type RelatorioInteligente = {
  texto: string;
  html: string;
  subject: string;
  metricas: Record<string, number | string | null>;
  periodo: string;
  modelo_ia: 'none';
  tokens: 0;
};

function rowCreated(r: any): string {
  return String(r.createdAt || r.createdat || r.created_at || '') || '';
}

export async function buildRelatorioInteligente(
  db: Database,
  empresa: { id: string; nome_empresa?: string; plan?: string; slug?: string },
  mesAno?: string | null
): Promise<RelatorioInteligente> {
  const nome = String(empresa.nome_empresa || 'Empresa');
  const plan = String(empresa.plan || 'trial');
  const mes =
    mesAno && /^\d{4}-\d{2}$/.test(mesAno)
      ? mesAno
      : new Date().toISOString().slice(0, 7);

  let rows: any[] = [];
  try {
    rows = await db.all(`SELECT * FROM reviews WHERE empresa_id = ? LIMIT 800`, [empresa.id]);
  } catch {
    rows = [];
  }

  const inMonth = (rows || []).filter((r) => {
    const c = rowCreated(r);
    return !mes || c.startsWith(mes);
  });
  const reais = inMonth.filter((r) => Number(r.is_test) !== 1);
  const total = reais.length;
  const soma = reais.reduce((s, r) => s + Number(r.rating || 0), 0);
  const media = total ? Math.round((soma / total) * 10) / 10 : 0;
  const pos = reais.filter((r) => Number(r.rating) >= 4).length;
  const neg = reais.filter((r) => Number(r.rating) <= 3).length;
  const crit = reais.filter((r) => Number(r.rating) <= 2).length;
  const trat = reais.filter((r) => r.treated_at && Number(r.rating) <= 3).length;
  const taxa = total ? Math.round((pos / total) * 100) : 0;
  const dist = [0, 0, 0, 0, 0];
  for (const r of reais) {
    const n = Number(r.rating);
    if (n >= 1 && n <= 5) dist[n - 1] += 1;
  }

  const texto = [
    `Relatório inteligente — ${nome}`,
    `Plano: ${planLabel(plan)} · Período: ${mes}`,
    ``,
    `Resumo (somente dados do painel):`,
    `• Avaliações no período: ${total}`,
    `• Nota média: ${media || '—'}`,
    `• Positivas (4–5★): ${pos}`,
    `• Negativas (1–3★): ${neg}`,
    `• Críticas (1–2★): ${crit}`,
    `• Negativas tratadas: ${trat}`,
    `• Taxa positiva: ${taxa}%`,
    `• Distribuição ★: 1=${dist[0]} 2=${dist[1]} 3=${dist[2]} 4=${dist[3]} 5=${dist[4]}`,
    ``,
    `Este relatório não usa IA e não inventa causas ou recomendações.`,
    `Gerado em ${new Date().toISOString()} · Filtra.AI`,
  ].join('\n');

  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5">
<h2>Relatório inteligente — ${escapeHtml(nome)}</h2>
<p><strong>Plano:</strong> ${escapeHtml(planLabel(plan))} · <strong>Período:</strong> ${escapeHtml(mes)}</p>
<ul>
<li>Avaliações: <strong>${total}</strong></li>
<li>Nota média: <strong>${media || '—'}</strong></li>
<li>Positivas: <strong>${pos}</strong> · Negativas: <strong>${neg}</strong></li>
<li>Críticas: <strong>${crit}</strong> · Tratadas: <strong>${trat}</strong></li>
<li>Taxa positiva: <strong>${taxa}%</strong></li>
</ul>
<p style="color:#666;font-size:13px">Sem IA · Filtra.AI</p>
</div>`;

  return {
    texto,
    html,
    subject: `Filtra.AI — Relatório ${mes} · ${nome}`,
    metricas: {
      total,
      media,
      positivas: pos,
      negativas: neg,
      criticas: crit,
      tratadas: trat,
      taxa_positiva: taxa,
    },
    periodo: mes,
    modelo_ia: 'none',
    tokens: 0,
  };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function normalizeDestinatarios(body: any): RelatorioDestino[] {
  const out: RelatorioDestino[] = [];
  const seen = new Set<string>();
  const push = (canal: string, destino: string) => {
    const c0 = String(canal || '').toLowerCase().trim();
    const d = String(destino || '').trim();
    if (!d) return;
    const c =
      c0 === 'wpp' ? 'whatsapp' : c0;
    if (!['email', 'whatsapp', 'sms', 'wechat'].includes(c)) return;
    const key = `${c}|${d.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ canal: c as RelatorioDestino['canal'], destino: d });
  };
  const list = body?.destinatarios || body?.destinations || [];
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === 'string') {
        if (item.includes('@')) push('email', item);
        else push('whatsapp', item);
      } else if (item && typeof item === 'object') {
        push(item.canal || item.channel || item.tipo, item.destino || item.to || item.value);
      }
    }
  }
  if (body?.email) push('email', String(body.email));
  if (body?.whatsapp) push('whatsapp', String(body.whatsapp));
  if (body?.sms) push('sms', String(body.sms));
  if (body?.wechat) push('wechat', String(body.wechat));
  return out.slice(0, 20);
}
