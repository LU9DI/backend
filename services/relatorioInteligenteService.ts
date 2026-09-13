/**
 * Relatório inteligente determinístico (0 tokens de IA).
 * Monta texto a partir dos dados do painel e dispara via n8n.
 */
import type { Database } from 'sqlite';
import crypto from 'crypto';
import { notifyN8n } from '../lib/n8n.js';
import { planTemRelatorio } from '../lib/plans.js';

export type CanalRelatorio = 'whatsapp' | 'sms' | 'email' | 'wechat';

export type Destinatario = {
  canal: CanalRelatorio;
  destino: string;
};

const CANAIS: CanalRelatorio[] = ['whatsapp', 'sms', 'email', 'wechat'];

export function normalizarCanal(v: string): CanalRelatorio | null {
  const c = String(v || '').toLowerCase().trim();
  if (c === 'wpp' || c === 'wa' || c === 'whatsapp') return 'whatsapp';
  if (c === 'sms' || c === 'texto') return 'sms';
  if (c === 'email' || c === 'e-mail' || c === 'mail') return 'email';
  if (c === 'wechat' || c === 'weixin') return 'wechat';
  return null;
}

export function validarDestino(canal: CanalRelatorio, destino: string): string | null {
  const d = String(destino || '').trim();
  if (!d) return 'Destino vazio.';
  if (canal === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d)) return 'E-mail inválido.';
    return null;
  }
  if (canal === 'whatsapp' || canal === 'sms') {
    const digits = d.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) return 'Telefone inválido (8–15 dígitos).';
    return null;
  }
  // wechat: openid ou handle livre
  if (d.length < 2 || d.length > 80) return 'WeChat ID inválido.';
  return null;
}

export async function ensureRelatorioSchema(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS relatorio_destinatarios (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      canal TEXT NOT NULL,
      destino TEXT NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL,
      UNIQUE(empresa_id, canal, destino)
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS relatorio_envios (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      mes TEXT NOT NULL,
      lang TEXT NOT NULL,
      canais_json TEXT NOT NULL,
      texto TEXT NOT NULL,
      n8n_ok INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT NOT NULL
    )
  `);
}

async function metricasMes(db: Database, empresaId: string, mesAno: string) {
  const [y, m] = mesAno.split('-').map(Number);
  const start = `${mesAno}-01`;
  const endDate = new Date(y, m, 0);
  const end = `${mesAno}-${String(endDate.getDate()).padStart(2, '0')}`;

  // createdAt pode ser TEXT ISO ou timestamp — LIKE cobre YYYY-MM
  const rows: any[] = await db.all(
    `SELECT rating, comment, sentimento, tags
     FROM reviews
     WHERE empresa_id = ?
       AND (
         substr(CAST(createdAt AS TEXT), 1, 7) = ?
         OR CAST(createdAt AS TEXT) LIKE ?
       )`,
    [empresaId, mesAno, `${mesAno}%`]
  );

  const total = rows.length;
  const sum = rows.reduce((a, r) => a + Number(r.rating || 0), 0);
  const media = total ? Math.round((sum / total) * 10) / 10 : 0;
  const dist = [0, 0, 0, 0, 0];
  let pos = 0;
  let neg = 0;
  for (const r of rows) {
    const rt = Math.min(5, Math.max(1, Number(r.rating) || 1));
    dist[rt - 1]++;
    if (rt >= 4) pos++;
    else if (rt <= 3) neg++;
  }
  const taxaPos = total ? Math.round((pos / total) * 100) : 0;

  return { total, media, dist, pos, neg, taxaPos, start, end };
}

export function montarTextoRelatorio(opts: {
  nomeEmpresa: string;
  mesAno: string;
  plan: string;
  lang: string;
  metricas: Awaited<ReturnType<typeof metricasMes>>;
}): string {
  const { nomeEmpresa, mesAno, plan, lang, metricas: m } = opts;
  const L = (lang || 'pt').toLowerCase().slice(0, 2);

  const titles: Record<string, string> = {
    pt: `Relatório inteligente — ${nomeEmpresa}`,
    en: `Smart report — ${nomeEmpresa}`,
    es: `Informe inteligente — ${nomeEmpresa}`,
    zh: `智能报告 — ${nomeEmpresa}`,
  };
  const lines: string[] = [];
  lines.push(titles[L] || titles.pt);
  lines.push(`Período: ${m.start} → ${m.end}`);
  lines.push(`Plano: ${plan}`);
  lines.push('');
  lines.push(`Avaliações: ${m.total}`);
  lines.push(`Média: ${m.media || '—'}★`);
  lines.push(`Positivas (4–5★): ${m.pos} | Críticas (1–3★): ${m.neg}`);
  lines.push(`Taxa positiva: ${m.taxaPos}%`);
  lines.push(`Distribuição: 1★ ${m.dist[0]} · 2★ ${m.dist[1]} · 3★ ${m.dist[2]} · 4★ ${m.dist[3]} · 5★ ${m.dist[4]}`);
  lines.push('');
  lines.push(
    L === 'en'
      ? 'Data only — no AI-generated advice. Summary of your panel metrics.'
      : 'Somente dados do painel — sem recomendações inventadas por IA.'
  );
  return lines.join('\n');
}

export async function listarDestinatarios(db: Database, empresaId: string) {
  await ensureRelatorioSchema(db);
  const rows = await db.all(
    `SELECT id, canal, destino, ativo, criado_em
     FROM relatorio_destinatarios
     WHERE empresa_id = ? AND ativo = 1
     ORDER BY canal, destino`,
    [empresaId]
  );
  return rows || [];
}

export async function salvarDestinatarios(
  db: Database,
  empresaId: string,
  lista: Destinatario[]
): Promise<{ saved: number; errors: string[] }> {
  await ensureRelatorioSchema(db);
  const errors: string[] = [];
  const clean: Destinatario[] = [];
  for (const item of lista.slice(0, 20)) {
    const canal = normalizarCanal(item.canal);
    if (!canal) {
      errors.push(`Canal inválido: ${item.canal}`);
      continue;
    }
    const err = validarDestino(canal, item.destino);
    if (err) {
      errors.push(`${canal}: ${err}`);
      continue;
    }
    const destino =
      canal === 'email'
        ? String(item.destino).trim().toLowerCase()
        : canal === 'wechat'
          ? String(item.destino).trim()
          : String(item.destino).replace(/\D/g, '');
    clean.push({ canal, destino });
  }

  // Desativa todos e reinsere (simples e previsível)
  await db.run(`UPDATE relatorio_destinatarios SET ativo = 0 WHERE empresa_id = ?`, [
    empresaId,
  ]);
  const now = new Date().toISOString();
  for (const d of clean) {
    const id = crypto.randomUUID();
    try {
      await db.run(
        `INSERT INTO relatorio_destinatarios (id, empresa_id, canal, destino, ativo, criado_em)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(empresa_id, canal, destino) DO UPDATE SET ativo = 1`,
        [id, empresaId, d.canal, d.destino, now]
      );
    } catch {
      // SQLite UPSERT alternativo se ON CONFLICT falhar em engines distintos
      await db.run(
        `INSERT INTO relatorio_destinatarios (id, empresa_id, canal, destino, ativo, criado_em)
         VALUES (?, ?, ?, ?, 1, ?)`,
        [id, empresaId, d.canal, d.destino, now]
      ).catch(() => undefined);
    }
  }
  return { saved: clean.length, errors };
}

export async function enviarRelatorioInteligente(
  db: Database,
  empresa: any,
  opts: { mesAno: string; lang: string; destinatarios?: Destinatario[] }
): Promise<{
  ok: boolean;
  texto: string;
  n8n: boolean;
  destinatarios: Destinatario[];
  error?: string;
}> {
  const plan = String(empresa.plan || '').toLowerCase();
  if (!planTemRelatorio(plan)) {
    return {
      ok: false,
      texto: '',
      n8n: false,
      destinatarios: [],
      error: 'Relatório inteligente não disponível neste plano (Inicial). Upgrade para Pro+ ou use o trial.',
    };
  }

  await ensureRelatorioSchema(db);

  let dests = opts.destinatarios || [];
  if (!dests.length) {
    const saved = await listarDestinatarios(db, empresa.id);
    dests = (saved as any[]).map((r) => ({
      canal: r.canal as CanalRelatorio,
      destino: r.destino,
    }));
  }

  if (!dests.length) {
    return {
      ok: false,
      texto: '',
      n8n: false,
      destinatarios: [],
      error: 'Cadastre ao menos um destino (WhatsApp, SMS, e-mail ou WeChat).',
    };
  }

  // validar
  const valid: Destinatario[] = [];
  for (const d of dests) {
    const canal = normalizarCanal(d.canal);
    if (!canal) continue;
    if (validarDestino(canal, d.destino)) continue;
    valid.push({
      canal,
      destino:
        canal === 'email'
          ? d.destino.trim().toLowerCase()
          : canal === 'wechat'
            ? d.destino.trim()
            : d.destino.replace(/\D/g, ''),
    });
  }
  if (!valid.length) {
    return {
      ok: false,
      texto: '',
      n8n: false,
      destinatarios: [],
      error: 'Nenhum destino válido.',
    };
  }

  const metricas = await metricasMes(db, empresa.id, opts.mesAno);
  const texto = montarTextoRelatorio({
    nomeEmpresa: empresa.nome_empresa || 'Empresa',
    mesAno: opts.mesAno,
    plan,
    lang: opts.lang,
    metricas,
  });

  const n8nOk = await notifyN8n('report.mensal', {
    empresa_id: empresa.id,
    slug: empresa.slug,
    nome_empresa: empresa.nome_empresa,
    plan,
    mes: opts.mesAno,
    lang: opts.lang,
    texto,
    metricas,
    destinatarios: valid,
    modelo_ia: 'none',
    tokens: 0,
  });

  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO relatorio_envios (id, empresa_id, mes, lang, canais_json, texto, n8n_ok, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      empresa.id,
      opts.mesAno,
      opts.lang,
      JSON.stringify(valid),
      texto,
      n8nOk ? 1 : 0,
      new Date().toISOString(),
    ]
  );

  if (!n8nOk) {
    return {
      ok: false,
      texto,
      n8n: false,
      destinatarios: valid,
      error:
        'Relatório gerado, mas o n8n não aceitou o envio. Verifique N8N_WEBHOOK_URL e o workflow ativo.',
    };
  }

  return { ok: true, texto, n8n: true, destinatarios: valid };
}

export { CANAIS };
