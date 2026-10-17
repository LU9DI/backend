/**
 * ETAPA 10 — prova funcional do Relatório profissional (Fase F).
 *
 * Dados sintéticos em SQLite descartável: build determinístico, gates de plano,
 * isolamento entre empresas, rotas reais (200/401/403/400/410/503) e destinatários.
 *
 * Uso (PowerShell, na raiz do backend):
 *   node_modules\.bin\tsx.cmd audit-etapa10\relatorio-smoke.ts
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(os.tmpdir(), `filtra-relatorio-smoke-${Date.now()}.sqlite`);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'auditoria-etapa10-secret-nao-usar-em-producao-0123456789';
process.env.SQLITE_DB_PATH = tmpDb;
delete process.env.N8N_WEBHOOK_URL;
delete process.env.N8N_URL;
delete process.env.N8N_WEBHOOK;

const checks: Array<{ nome: string; ok: boolean; detalhe: string }> = [];
function check(nome: string, cond: unknown, detalhe = '') {
  const ok = Boolean(cond);
  checks.push({ nome, ok, detalhe });
  console.log(`${ok ? 'OK   ' : 'FALHA'} ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
}

async function main() {
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const { initDB, getDb, closeDB } = await import('../lib/db.js');
  const { signAccessToken } = await import('../lib/auth.js');
  const { mountRelatorioRoutes } = await import('../routes/relatorioRoutes.js');
  const { buildRelatorioProfissional, normalizeDestinatarios } = await import('../services/relatorioProfissional.js');
  const { planTemRelatorio, empresaTemRelatorio } = await import('../lib/plans.js');
  const { ensureReviewTreatmentColumns } = await import('../lib/lgpd.js');
  const { ensureUnidadesSchema } = await import('../lib/unidades.js');

  await initDB();
  const db = getDb();

  // Migrações idempotentes que o boot do servidor aplica
  await ensureReviewTreatmentColumns(db);
  await ensureUnidadesSchema(db);
  for (const ddl of ['sentiment TEXT', 'origin TEXT', 'unidade_id TEXT']) {
    try { await db.exec(`ALTER TABLE reviews ADD COLUMN ${ddl}`); } catch { /* já existe */ }
  }
  try { await db.exec('ALTER TABLE usuarios ADD COLUMN email TEXT'); } catch { /* já existe */ }

  const mes = new Date().toISOString().slice(0, 7);
  const mesAntigo = '2025-01';
  const empresaA = crypto.randomUUID(); // corporativo
  const empresaB = crypto.randomUUID(); // rei
  const empresaC = crypto.randomUUID(); // inicial

  const expiraFuturo = new Date(Date.now() + 30 * 86400000).toISOString();
  const seedEmpresa = (id: string, plan: string, nome: string) =>
    db.run(
      'INSERT INTO empresas (id,cnpj,nome_empresa,slug,status,plan,criado_em,expira_em) VALUES (?,?,?,?,?,?,?,?)',
      [id, 'cnpj-' + crypto.randomUUID().replace(/-/g, '').slice(0, 14), nome, 'slug-' + id.slice(0, 8), 'ativo', plan, new Date().toISOString(), expiraFuturo],
    );
  await seedEmpresa(empresaA, 'corporativo', 'Empresa A Corporativo');
  await seedEmpresa(empresaB, 'rei', 'Empresa B Rei');
  await seedEmpresa(empresaC, 'inicial', 'Empresa C Inicial');

  await db.run(
    'INSERT INTO usuarios (id,cnpj,nome_funcionario,empresa_id,senha_hash,email) VALUES (?,?,?,?,?,?)',
    ['user-' + empresaA.slice(0, 8), 'cnpj-' + empresaA.slice(0, 12), 'Responsável A', empresaA, 'hash', 'dono-a@empresa-a.com'],
  );

  const unidadeA1 = crypto.randomUUID();
  const unidadeA2 = crypto.randomUUID();
  await db.run('INSERT INTO unidades (id,empresa_id,nome,ativo) VALUES (?,?,?,1)', [unidadeA1, empresaA, 'Loja Centro']);
  await db.run('INSERT INTO unidades (id,empresa_id,nome,ativo) VALUES (?,?,?,1)', [unidadeA2, empresaA, 'Loja Norte']);

  const addReview = (empresaId: string, rating: number, opts: any = {}) =>
    db.run(
      'INSERT INTO reviews (empresa_id,name,rating,comment,ai_tags,is_test,createdAt,unidade_id,origin,treated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [empresaId, opts.nome || 'Cliente', rating, opts.comment || 'comentario', JSON.stringify(opts.tags || []), opts.isTest ? 1 : 0, `${opts.mes || mes}-${opts.dia || '10'}T12:00:00.000Z`, opts.unidade_id || null, opts.origin || null, opts.treated_at || null],
    );

  // Empresa A (corporativo): 5 reais no mês + 1 de teste + 1 de mês antigo
  await addReview(empresaA, 5, { tags: ['atendimento'], unidade_id: unidadeA1, origin: 'centro' });
  await addReview(empresaA, 4, { tags: ['preco'], unidade_id: unidadeA1, origin: 'centro' });
  await addReview(empresaA, 1, { tags: ['demora'], unidade_id: unidadeA2, origin: 'norte', treated_at: `${mes}-12T10:00:00.000Z` });
  await addReview(empresaA, 3, { tags: ['demora'], unidade_id: unidadeA2, origin: 'norte' });
  await addReview(empresaA, 2, { tags: ['suporte'] });
  await addReview(empresaA, 5, { isTest: true });
  await addReview(empresaA, 1, { mes: mesAntigo, dia: '10' });
  // Empresa B (rei): 3 reais no mês
  await addReview(empresaB, 1, { tags: ['x'] });
  await addReview(empresaB, 2, { tags: ['y'] });
  await addReview(empresaB, 3, { tags: ['z'] });

  // Defeito do canônico (feat): a query de unidades do relatório referencia unidades.slug,
  // coluna que o schema atual nunca cria — o catch silencioso esvazia a seção de unidades.
  const probeSlugFalha = await db.get('SELECT id, nome, slug FROM unidades LIMIT 1').then(() => false).catch(() => true);
  check('defeito (canônico feat): query de unidades do relatório falha — coluna slug inexistente', probeSlugFalha, probeSlugFalha ? 'catch silencioso esvazia a seção de unidades (Corporativo/REI)' : 'coluna slug existe');

  // 1. Build determinístico (corporativo)
  const rel = await buildRelatorioProfissional(db, { id: empresaA, nome_empresa: 'Empresa A Corporativo', plan: 'corporativo', slug: 'slug-a' }, mes);
  check('build: schema_version 2.0 e tipo profissional', rel.schema_version === '2.0' && rel.tipo === 'relatorio_profissional');
  check('build: geracao determinística (0 tokens)', rel.geracao?.modo === 'deterministico' && rel.geracao?.tokens === 0);
  check('build: plano.codigo corporativo', rel.plano?.codigo === 'corporativo', `codigo=${rel.plano?.codigo}`);
  check('build: 5 avaliações reais no mês (exclui teste e mês antigo)', rel.kpis?.avaliacoes === 5, `avaliacoes=${rel.kpis?.avaliacoes}`);
  check('build: nota média 3.0', rel.kpis?.nota_media === 3, `media=${rel.kpis?.nota_media}`);
  check('build: 2 positivas / 3 críticas (1-3 estrelas) / 40% positivas', rel.kpis?.positivas === 2 && rel.kpis?.criticas === 3 && rel.kpis?.percentual_positivas === 40, JSON.stringify({ p: rel.kpis?.positivas, c: rel.kpis?.criticas, pp: rel.kpis?.percentual_positivas }));
  check('build: 1 crítica tratada', rel.kpis?.tratadas === 1, `tratadas=${rel.kpis?.tratadas}`);
  check('build: sentimento 2/1/2', rel.sentimento?.positivo === 2 && rel.sentimento?.neutro === 1 && rel.sentimento?.negativo === 2, JSON.stringify(rel.sentimento));
  check('build: distribuição de estrelas 1,1,1,1,1', JSON.stringify(rel.distribuicao_estrelas) === '[1,1,1,1,1]', JSON.stringify(rel.distribuicao_estrelas));
  check('build: unidades do Corporativo (2, com avaliações)', rel.unidades?.length === 2, `unidades=${rel.unidades?.length}`);
  check('build: tema de atenção "demora" com 2 ocorrências', rel.temas?.atencao?.[0]?.tema === 'demora' && rel.temas?.atencao?.[0]?.volume === 2, JSON.stringify(rel.temas?.atencao));
  check('build: canais prontos (email/whatsapp/sms/wechat)', typeof rel.canais?.email?.subject === 'string' && typeof rel.canais?.whatsapp === 'string' && typeof rel.canais?.sms === 'string' && typeof rel.canais?.wechat === 'string');
  check('build: isolamento — nada da Empresa B no relatório de A', !JSON.stringify(rel).includes('Empresa B') && !JSON.stringify(rel).includes('dono-b'));
  check('build: recomendação prioriza as 3 críticas (1-3 estrelas)', String(rel.recomendacoes?.[0] || '').includes('3 avaliações críticas'), String(rel.recomendacoes?.[0] || ''));

  // 2. Build REI: oportunidade executiva
  const relB = await buildRelatorioProfissional(db, { id: empresaB, nome_empresa: 'Empresa B Rei', plan: 'rei', slug: 'slug-b' }, mes);
  check('rei: 3 avaliações de B (não vaza de A)', relB.kpis?.avaliacoes === 3, `avaliacoes=${relB.kpis?.avaliacoes}`);
  check('rei: oportunidade executiva presente (ação de melhoria para tema de atenção)', (relB.oportunidades || []).some((o: any) => String(o.titulo).includes('Testar uma melhoria')), JSON.stringify(relB.oportunidades || []));
  check('rei: sem unidades cadastradas → sem risco de unidade', (relB.unidades || []).length === 0 && !(relB.riscos || []).some((r: any) => String(r.titulo).includes('Unidade com menor nota')));

  // 3. Gates de plano (funções usadas pelas rotas)
  check('gate: inicial não tem relatório', planTemRelatorio('inicial') === false);
  check('gate: pro/ultra/corporativo/rei/trial têm', ['pro', 'ultra', 'corporativo', 'rei', 'trial'].every((p) => planTemRelatorio(p)));
  check('gate: empresaTemRelatorio respeita plano', empresaTemRelatorio({ plan: 'inicial', status: 'ativo' }) === false && empresaTemRelatorio({ plan: 'corporativo', status: 'ativo' }) === true);

  // 4. Rotas reais (HTTP)
  const e = express();
  e.use(cookieParser());
  e.use(express.json({ limit: '20kb' }));
  mountRelatorioRoutes(e);
  const server: any = await new Promise((resolve) => { const s = e.listen(0, () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const tokenA = signAccessToken({ id: 'user-' + empresaA.slice(0, 8), nome_funcionario: 'Responsável A', empresa_id: empresaA, role: 'empresa' });
  const tokenB = signAccessToken({ id: 'user-' + empresaB.slice(0, 8), nome_funcionario: 'Responsável B', empresa_id: empresaB, role: 'empresa' });
  const tokenC = signAccessToken({ id: 'user-' + empresaC.slice(0, 8), nome_funcionario: 'Responsável C', empresa_id: empresaC, role: 'empresa' });

  const get = async (p: string, token?: string) => {
    const r = await fetch(baseUrl + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as any };
  };
  const post = async (p: string, body: any, token?: string) => {
    const r = await fetch(baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as any };
  };

  const g1 = await get(`/api/empresa/${empresaA}/relatorio?mes=${mes}`, tokenA);
  check('rota: preview 200 com KPIs e n8n_configured=false', g1.status === 200 && g1.data.kpis?.avaliacoes === 5 && g1.data.n8n_configured === false, `status=${g1.status}`);
  const g2 = await get(`/api/empresa/${empresaA}/relatorio`, tokenB);
  check('rota: token de outra empresa → 403', g2.status === 403, `status=${g2.status}`);
  const g3 = await get(`/api/empresa/${empresaA}/relatorio`);
  check('rota: sem token → 401', g3.status === 401, `status=${g3.status}`);
  const g4 = await get(`/api/empresa/${empresaC}/relatorio`, tokenC);
  check('rota: plano inicial → 403 PLAN_NO_REPORT', g4.status === 403 && g4.data.code === 'PLAN_NO_REPORT', `status=${g4.status} code=${g4.data.code}`);
  const g5 = await get(`/api/empresa/${empresaA}/relatorio.pdf`);
  check('rota: .pdf legado → 410 REPORT_LEGACY_FORMAT_GONE', g5.status === 410 && g5.data.code === 'REPORT_LEGACY_FORMAT_GONE', `status=${g5.status} code=${g5.data.code}`);
  const g5b = await get(`/api/empresa/${empresaA}/relatorio-inteligente.pdf`);
  check('rota: relatorio-inteligente.pdf legado → 410', g5b.status === 410 && g5b.data.code === 'REPORT_LEGACY_FORMAT_GONE', `status=${g5b.status}`);
  const g6 = await get(`/api/empresa/${empresaA}/relatorio?mes=1999-01`, tokenA);
  check('rota: mês fora da janela → 400 INVALID_REPORT_MONTH', g6.status === 400 && g6.data.code === 'INVALID_REPORT_MONTH', `status=${g6.status} code=${g6.data.code}`);

  const p1 = await post(`/api/empresa/${empresaA}/relatorio/enviar`, {}, tokenA);
  check('rota: envio sem destinatário usa e-mail do usuário → 503 N8N_OFF com preview', p1.status === 503 && p1.data.code === 'N8N_OFF' && p1.data.preview?.kpis?.avaliacoes === 5, `status=${p1.status} code=${p1.data.code}`);
  const p2 = await post(`/api/empresa/${empresaA}/relatorio/enviar`, { destinatarios: Array.from({ length: 21 }, (_, i) => ({ canal: 'email', destino: `u${i}@x.com` })) }, tokenA);
  check('rota: 21 destinatários → 400 TOO_MANY_RECIPIENTS', p2.status === 400 && p2.data.code === 'TOO_MANY_RECIPIENTS', `status=${p2.status} code=${p2.data.code}`);
  const p3 = await post(`/api/empresa/${empresaB}/relatorio/enviar`, {}, tokenB);
  check('rota: sem destinatário e sem fallback → 400 NO_DESTINATARIO', p3.status === 400 && p3.data.code === 'NO_DESTINATARIO', `status=${p3.status} code=${p3.data.code}`);

  const d1 = await get(`/api/empresa/${empresaA}/relatorio/destinatarios`, tokenA);
  check('destinatários: leitura inicial vazia', d1.status === 200 && d1.data.ativo === false && Array.isArray(d1.data.destinatarios) && d1.data.destinatarios.length === 0, `status=${d1.status}`);
  const r1 = await fetch(baseUrl + `/api/empresa/${empresaA}/relatorio/destinatarios`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ destinatarios: ['dono-a@empresa-a.com', { canal: 'wpp', destino: '+5511999999999' }] }) });
  const r1d: any = await r1.json().catch(() => ({}));
  check('destinatários: gravação normaliza wpp→whatsapp (2)', r1.status === 200 && r1d.ativo === true && r1d.destinatarios?.length === 2 && r1d.destinatarios?.[1]?.canal === 'whatsapp', `status=${r1.status}`);
  const d2 = await get(`/api/empresa/${empresaA}/relatorio/destinatarios`, tokenA);
  check('destinatários: leitura reflete a gravação', d2.status === 200 && d2.data.destinatarios?.length === 2, `status=${d2.status} n=${d2.data.destinatarios?.length}`);

  // 5. Normalização (sem HTTP)
  const norm = normalizeDestinatarios({ destinatarios: ['a@x.com', 'a@x.com', { canal: 'wpp', destino: '+5511999999999' }, { canal: 'sms', destino: '+5511888888888' }, { canal: 'fax', destino: 'x' }] });
  check('normalizeDestinatarios: dedup + wpp→whatsapp + canal inválido fora', norm.length === 3 && norm[0].canal === 'email' && norm[1].canal === 'whatsapp' && norm[2].canal === 'sms', JSON.stringify(norm));

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDB();
  try { fs.unlinkSync(tmpDb); } catch { /* ok */ }

  const falhas = checks.filter((c) => !c.ok);
  console.log(`\nRESULTADO: ${checks.length - falhas.length}/${checks.length} verificações OK`);
  if (falhas.length) {
    console.log('FALHAS: ' + falhas.map((f) => f.nome).join(' | '));
    console.log('RELATORIO-SMOKE-VEREDITO: falhas=' + falhas.length);
    process.exit(1);
  }
  console.log('RELATORIO-SMOKE-VEREDITO: todos_ok');
  process.exit(0);
}

main().catch((err) => {
  console.error('ERRO FATAL:', err);
  process.exit(1);
});
