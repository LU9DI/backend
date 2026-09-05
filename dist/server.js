/**
 * ============================================================================
 * 🚀 GITHUB SPEC KIT - METADADOS DE ESPECIFICAÇÃO E CONSTITUIÇÃO DO MICRO-SAAS
 * ============================================================================
 *
 * @meta github-spec-kit: true
 * @version 1.2.0
 * @framework Next.js 14 (Frontend) | Node 24 + Express + SQLite (Backend)
 *
 * /constitution (Regras e Padrões de Arquitetura Imutáveis)
 * -------------------------------------------------------------
 * 1. SEGURANÇA: Isolamento estrito de dados por ID da empresa (Tenant Isolation).
 *    Cada funcionário tem **senha própria** (hash bcrypt) porém a **autenticação do
 *    painel usa o mesmo CNPJ da empresa** como identificador de tenant.
 * 2. AUTENTICAÇÃO: Stateless via JWT (24h). O payload do token contém
 *    `nome_funcionario` e `empresa_id` de forma isolada (sem e‑mail).
 * 3. IDIOMAS: Suporte nativo a PT, EN, ES via dicionários estáticos puros de
 *    tradução.
 * 4. CANAL UNIVERSAL: Rastreamento omnicanal via parâmetro `origin` no banco de dados.
 *
 * /plan (Tabela de Precificação, Limites Globais e Regras de IA)
 * --------------------------------------------------
 * - PLANO PRO MENSAL (R$ 69,90) | ANUAL (R$ 49,90/mês): Limite de 150 avaliações/mês.
 *   Inclui WhatsApp integrado (botão de crise), gráficos visuais básicos e cancelamento sem multa. Sem IA.
 * - PLANO ULTRA (R$ 199,90/mês): Limite de 1.000 avaliações/mês.
 *   Inclui WhatsApp integrado, DASHBOARD SIMPLES, 1 Relatório Mensal em PDF por IA e respostas personalizadas por IA.
 * - PLANO CORPORATIVO (R$ 499,90/mês): Avaliações ilimitadas.
 *   Inclui WhatsApp integrado, IA sem limites, 1 Relatório Mensal e DASHBOARD COMPLETO Multi-Unidades (Franquias/Filiais).
 *
 * /specify (O Comportamento Desejado do Fluxo Atual)
 * -----------------------------------------------------
 * - TELA DE ATIVAÇÃO (`/ativar` ou `/`): Cadastro (Nome, CNPJ, E-mail, Senha) para iniciar 7 dias grátis.
 *   Grade de planos exibida abaixo. Cliques nos planos redirecionam para inserção de cartão no Stripe.
 * - TELA DE LOGIN (`/login`): Rota isolada para o uso diário de clientes ativos.
 * - RECUPERAÇÃO DE SENHA: via e-mail (`/api/auth/forgot-password` + `/api/auth/reset-password`).
 *
 * /tasks
 * -------------------------------------------------
 * [x] Task 1: Centralizar e unificar o motor de IA no arquivo `server.ts`.
 * [x] Task 2: Atualizar o ID do modelo da Groq para `openai/gpt-oss-120b`.
 * [x] Task wire: Stripe + recuperação de senha + trial com e-mail/senha.
 * ============================================================================
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';
import { mountPasswordResetRoutes, createUsuarioForEmpresa, ensureAuthColumns } from './passwordResetRoutes.js';
import { mountStripeRoutes } from './stripeRoutes.js';
import { stripeConfigured } from './stripeBilling.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cookieParser());
// JSON em todas as rotas, exceto webhook Stripe (precisa do body cru)
app.use((req, res, next) => {
    if (req.originalUrl?.startsWith('/api/webhook/stripe'))
        return next();
    return express.json({ limit: '20kb' })(req, res, next);
});
const allowedOrigins = [process.env.FRONTEND_URL || 'http://localhost:3000'].filter(Boolean);
app.use(cors({
    origin: true,
    credentials: true,
}));
export let db;
const COOKIE_NAME = 'saas_auth_token';
const isProd = process.env.NODE_ENV === 'production';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
function setAuthCookie(res, token) {
    res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? 'none' : 'lax',
        maxAge: 24 * 60 * 60 * 1000,
        path: '/',
    });
}
function clearAuthCookie(res) {
    res.clearCookie(COOKIE_NAME, {
        httpOnly: true,
        secure: isProd,
        sameSite: isProd ? 'none' : 'lax',
        path: '/',
    });
}
function slugify(texto) {
    return texto
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'empresa';
}
async function slugUnico(base) {
    let slug = base;
    let n = 0;
    while (true) {
        const existe = await db.get('SELECT id FROM empresas WHERE slug = ?', [slug]);
        if (!existe)
            return slug;
        n += 1;
        slug = `${base}-${n}`;
    }
}
async function findEmpresa(ref) {
    if (!ref)
        return null;
    const porId = await db.get('SELECT * FROM empresas WHERE id = ?', [ref]);
    if (porId)
        return porId;
    return db.get('SELECT * FROM empresas WHERE slug = ?', [ref]);
}
function linksEmpresa(slugOrId, plan = 'trial') {
    const key = slugOrId;
    return {
        avaliacao: `${APP_URL}/avaliacao/${key}`,
        painel: `${APP_URL}/painel/${key}`,
        widget: `${APP_URL}/widget/${key}`,
        embed: `<iframe src="${APP_URL}/widget/${key}" width="100%" height="420" frameborder="0" style="border:0;border-radius:12px;" title="Avaliações"></iframe>`,
        whatsapp: montarWhatsAppLink(plan, key),
    };
}
const planosTeste = ['inicial', 'pro', 'ultra', 'corporativo', 'rei'];
function obterPlanoTeste(valor) {
    const plano = String(valor || '').trim().toLowerCase();
    return process.env.NODE_ENV !== 'production' && planosTeste.includes(plano) ? plano : null;
}
async function initDB() {
    const dbPath = process.env.SQLITE_DB_PATH || (isProd ? '/data/database.sqlite' : path.resolve(__dirname, '..', 'data', 'database.sqlite'));
    console.log(`💾 Inicializando banco de dados SQLite em: ${dbPath}`);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec(`
    CREATE TABLE IF NOT EXISTS empresas (
      id TEXT PRIMARY KEY,
      cnpj TEXT UNIQUE NOT NULL,
      nome_empresa TEXT NOT NULL,
      slug TEXT UNIQUE,
      status TEXT DEFAULT 'trial',
      plan TEXT DEFAULT 'trial',
      criado_em DATETIME NOT NULL,
      expira_em DATETIME NOT NULL,
      google_review_url TEXT,
      voice_style TEXT,
      empresa_pai_id TEXT
    );
  `);
    await db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      plan TEXT NOT NULL,
      month TEXT NOT NULL,
      tags INTEGER DEFAULT 0,
      respostas INTEGER DEFAULT 0,
      PRIMARY KEY (plan, month)
    );
  `);
    await db.exec(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT,
      tipo TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (empresa_id) REFERENCES empresas(id)
    );
  `);
    await db.exec(`
    CREATE TABLE IF NOT EXISTS qrcodes (
      id TEXT PRIMARY KEY,
      empresa_id TEXT NOT NULL,
      criado_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (empresa_id) REFERENCES empresas(id)
    );
  `);
    await db.exec(`
    CREATE TABLE IF NOT EXISTS relatorios_mensais (
      empresa_id TEXT NOT NULL,
      mes TEXT NOT NULL,
      total INTEGER,
      media REAL,
      negativas INTEGER,
      positivas INTEGER,
      PRIMARY KEY (empresa_id, mes)
    );
  `);
    const colunasEmpresas = await db.all(`PRAGMA table_info(empresas)`);
    const nomes = colunasEmpresas.map((c) => c.name);
    if (!nomes.includes('google_review_url'))
        await db.exec(`ALTER TABLE empresas ADD COLUMN google_review_url TEXT`);
    if (!nomes.includes('voice_style'))
        await db.exec(`ALTER TABLE empresas ADD COLUMN voice_style TEXT`);
    if (!nomes.includes('slug'))
        await db.exec(`ALTER TABLE empresas ADD COLUMN slug TEXT`);
    if (!nomes.includes('plan'))
        await db.exec(`ALTER TABLE empresas ADD COLUMN plan TEXT DEFAULT 'trial'`);
    if (!nomes.includes('whatsapp_suporte'))
        await db.exec(`ALTER TABLE empresas ADD COLUMN whatsapp_suporte TEXT`);
    if (!nomes.includes('empresa_pai_id'))
        await db.exec(`ALTER TABLE empresas ADD COLUMN empresa_pai_id TEXT`);
    const semSlug = await db.all('SELECT id, nome_empresa FROM empresas WHERE slug IS NULL OR slug = ""');
    for (const e of semSlug) {
        const base = slugify(e.nome_empresa);
        const slug = await slugUnico(base);
        await db.run('UPDATE empresas SET slug = ? WHERE id = ?', [slug, e.id]);
        console.log(`🔗 Slug gerado: ${slug} ← ${e.nome_empresa}`);
    }
    try {
        await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_slug ON empresas(slug)`);
    }
    catch { /* ok */ }
    await db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY,
      cnpj TEXT NOT NULL,
      nome_funcionario TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      senha_hash TEXT NOT NULL,
      FOREIGN KEY (empresa_id) REFERENCES empresas(id)
    );
  `);
    await db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT,
      name TEXT,
      rating INTEGER,
      comment TEXT,
      ai_reply TEXT,
      ai_tags TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
    const colunasReviews = await db.all(`PRAGMA table_info(reviews)`);
    if (!colunasReviews.some((col) => col.name === 'ai_reply'))
        await db.exec(`ALTER TABLE reviews ADD COLUMN ai_reply TEXT`);
    if (!colunasReviews.some((col) => col.name === 'ai_tags'))
        await db.exec(`ALTER TABLE reviews ADD COLUMN ai_tags TEXT`);
    await ensureAuthColumns(db);
    const adminExiste = await db.get('SELECT * FROM usuarios WHERE email = ?', ['admin@seusaas.com']);
    if (!adminExiste) {
        const senhaPadrao = process.env.ADMIN_PASSWORD || 'MudeEstaSenha123!';
        const hash = await bcrypt.hash(senhaPadrao, 10);
        await db.run('INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash, email) VALUES (?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), '00000000000000', 'Admin', 'admin', hash, 'admin@seusaas.com']);
        console.log('🔑 Admin padrão criado. Altere a senha após o primeiro login.');
    }
}
function normalizarCnpj(cnpj) {
    return cnpj.replace(/\D/g, '');
}
function cnpjValido(cnpj) {
    if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj))
        return false;
    const calcularDigito = (base, pesoInicial) => {
        let soma = 0;
        let peso = pesoInicial;
        for (let i = 0; i < base.length; i++) {
            soma += parseInt(base[i]) * peso;
            peso = peso === 2 ? 9 : peso - 1;
        }
        const resto = soma % 11;
        return resto < 2 ? 0 : 11 - resto;
    };
    const digito1 = calcularDigito(cnpj.slice(0, 12), 5);
    const digito2 = calcularDigito(cnpj.slice(0, 12) + digito1, 6);
    return parseInt(cnpj[12]) === digito1 && parseInt(cnpj[13]) === digito2;
}
function validarReview(body) {
    const name = String(body.name ?? '').trim().slice(0, 100);
    const comment = String(body.comment ?? '').trim().slice(0, 500);
    const rating = Number(body.rating);
    const empresa_ref = body.empresa_id ? String(body.empresa_id).slice(0, 100) : undefined;
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return { error: 'Rating deve ser um número inteiro entre 1 e 5.' };
    }
    if (rating <= 3 && comment.length === 0) {
        return { error: 'Comentário é obrigatório para avaliações negativas.' };
    }
    return { name, rating, comment, empresa_ref };
}
function safeParseTags(raw) {
    try {
        const p = JSON.parse(raw);
        return Array.isArray(p) ? p : [];
    }
    catch {
        return [];
    }
}
const JWT_SECRET = process.env.JWT_SECRET ?? '';
if (!JWT_SECRET) {
    console.error('❌ JWT_SECRET não definido. Encerrando o servidor.');
    process.exit(1);
}
function extrairToken(req) {
    const fromCookie = req.cookies?.[COOKIE_NAME];
    if (fromCookie)
        return fromCookie;
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer '))
        return authHeader.slice(7);
    return null;
}
function autenticarToken(req, res, next) {
    const token = extrairToken(req);
    if (!token)
        return res.status(401).json({ error: 'Token não fornecido.' });
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = {
            id: payload.id,
            nome_funcionario: payload.nome_funcionario,
            empresa_id: payload.empresa_id,
        };
        next();
    }
    catch {
        return res.status(401).json({ error: 'Token inválido ou expirado.' });
    }
}
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Muitas tentativas de login. Tente novamente mais tarde.' },
});
const trialLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    message: { error: 'Limite de ativações excedido. Tente novamente mais tarde.' },
});
const reviewsLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    message: { error: 'Muitas avaliações enviadas. Tente novamente mais tarde.' },
});
const aiLastCall = new Map();
const AI_COOLDOWN_MS = 1500;
function exigirIntervaloIA(chave) {
    const agora = Date.now();
    const ultima = aiLastCall.get(chave) || 0;
    if (agora - ultima < AI_COOLDOWN_MS) {
        throw new Error('Aguarde alguns instantes antes de solicitar outra análise de IA.');
    }
    aiLastCall.set(chave, agora);
}
async function registrarConsumoIA(empresaId, tipo, texto) {
    const tokensEstimados = Math.max(1, Math.ceil(String(texto || '').length / 4));
    await db.run('INSERT INTO ai_usage (empresa_id, tipo, tokens) VALUES (?, ?, ?)', [empresaId, tipo, tokensEstimados]);
}
// ---- Trial (CNPJ + e-mail + senha, sem cartão) ----
app.post('/api/trial/ativar', trialLimiter, async (req, res) => {
    try {
        const cnpj = normalizarCnpj(req.body.cnpj ?? '');
        const nome = String(req.body.nome_empresa ?? '').trim().slice(0, 120);
        const googleReviewUrl = String(req.body.google_review_url ?? '').trim().slice(0, 500);
        const email = String(req.body.email ?? '').trim().toLowerCase();
        const senha = String(req.body.senha ?? '');
        if (!cnpjValido(cnpj))
            return res.status(400).json({ error: 'CNPJ inválido.' });
        if (nome.length < 2 || nome.length > 120)
            return res.status(400).json({ error: 'Nome da empresa inválido.' });
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'E-mail inválido.' });
        }
        if (senha.length < 6)
            return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
        if (googleReviewUrl && !/^https?:\/\//i.test(googleReviewUrl)) {
            return res.status(400).json({ error: 'URL do Google Reviews inválida.' });
        }
        const id = crypto.randomUUID();
        const slug = await slugUnico(slugify(nome));
        const criadoEm = new Date();
        const expiraEm = new Date(criadoEm.getTime() + 7 * 24 * 60 * 60 * 1000);
        try {
            await db.run(`INSERT INTO empresas (id, cnpj, nome_empresa, slug, google_review_url, criado_em, expira_em)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, cnpj, nome, slug, googleReviewUrl || null, criadoEm.toISOString(), expiraEm.toISOString()]);
        }
        catch (e) {
            if (e.code === 'SQLITE_CONSTRAINT') {
                return res.status(409).json({ error: 'Este CNPJ já ativou o período de testes.' });
            }
            throw e;
        }
        try {
            await createUsuarioForEmpresa(db, { empresaId: id, cnpj, nome, email, senha });
        }
        catch (e) {
            await db.run('DELETE FROM empresas WHERE id = ?', [id]);
            return res.status(400).json({ error: e.message || 'Falha ao criar usuário.' });
        }
        const links = linksEmpresa(slug);
        res.status(201).json({
            success: true,
            empresa_id: id,
            slug,
            link_acesso: links.avaliacao,
            link_painel: links.painel,
            link_widget: links.widget,
            expira_em: expiraEm.toISOString(),
        });
    }
    catch (error) {
        console.error('Erro ao ativar trial:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});
app.get('/api/empresa/:ref/validar', async (req, res) => {
    try {
        const empresa = await findEmpresa(req.params.ref);
        if (!empresa)
            return res.status(404).json({ valido: false, motivo: 'not_found' });
        const agora = new Date();
        const dataExpiracao = new Date(empresa.expira_em);
        if (empresa.status === 'trial' && agora > dataExpiracao) {
            return res.json({
                valido: false,
                motivo: 'expired',
                nome: empresa.nome_empresa,
                empresa_id: empresa.id,
                slug: empresa.slug,
                google_review_url: empresa.google_review_url || null,
                whatsapp_suporte: empresa.whatsapp_suporte || null,
            });
        }
        if (empresa.status === 'ativo' || empresa.status === 'trial') {
            return res.json({
                valido: true,
                nome: empresa.nome_empresa,
                empresa_id: empresa.id,
                slug: empresa.slug,
                google_review_url: empresa.google_review_url || null,
                whatsapp_suporte: empresa.whatsapp_suporte || null,
            });
        }
        return res.json({
            valido: false,
            motivo: 'inactive',
            nome: empresa.nome_empresa,
            empresa_id: empresa.id,
            slug: empresa.slug,
            google_review_url: empresa.google_review_url || null,
            whatsapp_suporte: empresa.whatsapp_suporte || null,
        });
    }
    catch (error) {
        console.error('Erro ao validar:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});
app.get('/api/empresa/:ref/widget', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 6, 20);
    try {
        const empresa = await findEmpresa(req.params.ref);
        if (!empresa)
            return res.status(404).json({ error: 'Empresa não encontrada.' });
        const reviews = await db.all(`SELECT name, rating, comment, createdAt FROM reviews
       WHERE empresa_id = ? AND rating >= 4 AND comment IS NOT NULL AND TRIM(comment) != ''
       ORDER BY createdAt DESC LIMIT ?`, [empresa.id, limit]);
        res.json({
            empresa: { id: empresa.id, slug: empresa.slug, nome: empresa.nome_empresa },
            reviews,
        });
    }
    catch (error) {
        console.error('Erro no widget:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});
app.get('/api/empresa/:ref/painel', async (req, res) => {
    try {
        const empresa = await findEmpresa(req.params.ref);
        if (!empresa)
            return res.status(404).json({ error: 'Empresa não encontrada.' });
        const reviews = await db.all('SELECT * FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC LIMIT 200', [empresa.id]);
        const parsed = reviews.map((r) => ({
            ...r,
            ai_tags: r.ai_tags ? safeParseTags(r.ai_tags) : [],
        }));
        const total = parsed.length;
        const media = total > 0 ? parsed.reduce((s, r) => s + r.rating, 0) / total : 0;
        const negativas = parsed.filter((r) => r.rating <= 3).length;
        const positivas = parsed.filter((r) => r.rating >= 4).length;
        const oldestCurrent = parsed[parsed.length - 1]?.createdAt;
        let prevTotal = 0;
        let prevMedia = 0;
        let evolucaoPercentual = 0;
        if (oldestCurrent) {
            const previous = await db.all(`SELECT * FROM reviews WHERE empresa_id = ? AND createdAt < ? ORDER BY createdAt DESC LIMIT ?`, [empresa.id, oldestCurrent, total]);
            prevTotal = previous.length;
            const prevSum = previous.reduce((s, r) => s + r.rating, 0);
            prevMedia = prevTotal > 0 ? prevSum / prevTotal : 0;
            evolucaoPercentual = prevMedia === 0 ? 0 : ((media - prevMedia) / prevMedia) * 100;
        }
        const ha24h = Date.now() - 24 * 60 * 60 * 1000;
        const crisesRecentes = parsed.filter((r) => r.rating <= 2 && new Date(r.createdAt).getTime() >= ha24h).length;
        const key = empresa.slug || empresa.id;
        const planoExibicao = obterPlanoTeste(req.query.previewPlan) || empresa.plan || 'trial';
        const serieMensal = await db.all(`SELECT strftime('%Y-%m', createdAt) AS mes,
              COUNT(*) AS total,
              ROUND(AVG(rating), 1) AS media,
              SUM(CASE WHEN rating <= 3 THEN 1 ELSE 0 END) AS negativas
       FROM reviews
       WHERE empresa_id = ?
       GROUP BY strftime('%Y-%m', createdAt)
       ORDER BY mes DESC LIMIT 6`, [empresa.id]);
        res.json({
            empresa: {
                id: empresa.id,
                slug: empresa.slug,
                nome_empresa: empresa.nome_empresa,
                plan: planoExibicao,
                whatsapp_suporte: empresa.whatsapp_suporte || null,
                status: empresa.status,
                cnpj: empresa.cnpj,
                google_review_url: empresa.google_review_url,
                criado_em: empresa.criado_em,
                expira_em: empresa.expira_em,
                voice_style: empresa.voice_style || '',
            },
            reviews: parsed,
            metricas: {
                total,
                media: Math.round(media * 10) / 10,
                prevTotal,
                prevMedia: Math.round(prevMedia * 10) / 10,
                evolucao_percentual: Math.round(evolucaoPercentual * 10) / 10,
                negativas,
                positivas,
                alerta_crise: crisesRecentes >= 3,
                crises_24h: crisesRecentes,
                serie_mensal: serieMensal.reverse(),
            },
            links: linksEmpresa(key),
        });
    }
    catch (error) {
        console.error('Erro no painel:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});
app.put('/api/empresa/:ref/voice-style', async (req, res) => {
    const voiceStyle = String(req.body.voice_style ?? '').trim().slice(0, 3000);
    try {
        const empresa = await findEmpresa(req.params.ref);
        if (!empresa)
            return res.status(404).json({ error: 'Empresa não encontrada.' });
        await db.run('UPDATE empresas SET voice_style = ? WHERE id = ?', [voiceStyle || null, empresa.id]);
        res.json({ success: true });
    }
    catch (error) {
        console.error('Erro ao salvar voice_style:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});
app.post('/api/whatsapp_suporte', async (req, res) => {
    const { empresa_ref, numero } = req.body;
    if (!numero)
        return res.status(400).json({ error: 'Número de WhatsApp é obrigatório.' });
    const cleaned = String(numero).replace(/\D/g, '');
    if (cleaned.length < 10)
        return res.status(400).json({ error: 'Número de WhatsApp inválido.' });
    try {
        const empresa = await findEmpresa(empresa_ref);
        if (!empresa)
            return res.status(404).json({ error: 'Empresa não encontrada.' });
        await db.run('UPDATE empresas SET whatsapp_suporte = ? WHERE id = ?', [cleaned, empresa.id]);
        res.json({ success: true, whatsapp_suporte: cleaned });
    }
    catch (error) {
        console.error('Erro ao salvar whatsapp_suporte:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});
app.post('/api/reviews', reviewsLimiter, async (req, res) => {
    const resultado = validarReview(req.body);
    if ('error' in resultado)
        return res.status(400).json({ error: resultado.error });
    const { name, rating, comment, empresa_ref } = resultado;
    try {
        let empresaId = null;
        let nomeEmpresa;
        let voiceStyle;
        let plan = 'trial';
        if (empresa_ref) {
            const empresa = await findEmpresa(empresa_ref);
            if (empresa) {
                empresaId = empresa.id;
                nomeEmpresa = empresa.nome_empresa;
                voiceStyle = empresa.voice_style || undefined;
                plan = empresa.plan || 'trial';
            }
        }
        const limits = {
            trial: 30,
            inicial: 150,
            pro: 400,
            ultra: 800,
            corporate: 3500,
            corporativo: 3500,
            rei: 10000,
        };
        if (empresaId) {
            const now = new Date();
            const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            const row = await db.get('SELECT COUNT(*) as cnt FROM reviews WHERE empresa_id = ? AND strftime("%Y-%m", createdAt) = ?', [empresaId, month]);
            const count = row?.cnt ?? 0;
            const planKey = String(plan).trim().toLowerCase();
            if (count >= (limits[planKey] ?? limits['trial'])) {
                return res.status(429).json({
                    error: `Limite mensal de avaliações (${limits[planKey] ?? limits.trial}) atingido para o plano ${plan}.`,
                });
            }
            const comentario = String(comment || '').trim();
            if (comentario) {
                const duplicado = await db.get(`SELECT id FROM reviews WHERE empresa_id = ? AND LOWER(TRIM(comment)) = LOWER(TRIM(?)) LIMIT 1`, [empresaId, comentario]);
                if (duplicado)
                    return res.status(409).json({ error: 'Este comentário já foi registrado para esta empresa.' });
            }
        }
        let aiReply = null;
        let aiTags = [];
        if (process.env.GROQ_API_KEY) {
            try {
                aiTags = (await gerarTagsSemanticas(comment || ''))
                    .split(',')
                    .map((tag) => tag.trim())
                    .filter(Boolean)
                    .slice(0, 3);
                await registrarConsumoIA(empresaId, 'tags', comment || '');
            }
            catch (e) {
                console.error('Falha ao gerar tags:', e);
            }
            if (rating <= 3 && comment) {
                try {
                    aiReply = await gerarRespostaReview(name, rating, comment, nomeEmpresa, voiceStyle);
                    await registrarConsumoIA(empresaId, 'resposta', comment);
                }
                catch (e) {
                    console.error('Falha ao gerar resposta IA:', e);
                }
            }
        }
        await db.run('INSERT INTO reviews (empresa_id, name, rating, comment, ai_reply, ai_tags) VALUES (?, ?, ?, ?, ?, ?)', [empresaId, name, rating, comment, aiReply, JSON.stringify(aiTags)]);
        res.status(201).json({ success: true, ai_reply: aiReply, ai_tags: aiTags });
    }
    catch (error) {
        console.error('Erro ao salvar review:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});
app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { cnpj, senha } = req.body;
    if (!cnpj || !senha)
        return res.status(400).json({ error: 'CNPJ e senha são obrigatórios.' });
    try {
        const cnpjNorm = normalizarCnpj(cnpj);
        const usuario = await db.get('SELECT * FROM usuarios WHERE cnpj = ?', [cnpjNorm]);
        if (!usuario)
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        const senhaCorreta = await bcrypt.compare(senha, usuario.senha_hash);
        if (!senhaCorreta)
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        const token = jwt.sign({ id: usuario.id, nome_funcionario: usuario.nome_funcionario, empresa_id: usuario.empresa_id }, JWT_SECRET, { expiresIn: '1d' });
        setAuthCookie(res, token);
        res.json({
            success: true,
            tokenPayload: {
                id: usuario.id,
                nome_funcionario: usuario.nome_funcionario,
                empresa_id: usuario.empresa_id,
            },
        });
    }
    catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});
app.post('/api/admin/login', loginLimiter, async (req, res) => {
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const senha = String(req.body.senha ?? '');
    if (!email || !senha)
        return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    try {
        const usuario = await db.get('SELECT * FROM usuarios WHERE email = ?', [email]);
        if (!usuario || usuario.email !== 'admin@seusaas.com') {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }
        const senhaCorreta = await bcrypt.compare(senha, usuario.senha_hash);
        if (!senhaCorreta)
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        const token = jwt.sign({ id: usuario.id, email: usuario.email }, JWT_SECRET, { expiresIn: '1d' });
        setAuthCookie(res, token);
        res.json({ success: true, user: { id: usuario.id, email: usuario.email } });
    }
    catch (error) {
        console.error('Erro no login administrativo:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});
app.post('/api/admin/logout', (_req, res) => {
    clearAuthCookie(res);
    res.json({ success: true });
});
app.get('/api/admin/me', autenticarToken, (req, res) => {
    res.json({ user: req.user });
});
app.get('/api/admin/empresas', autenticarToken, async (_req, res) => {
    try {
        const empresas = await db.all('SELECT id, slug, cnpj, nome_empresa, status, google_review_url, criado_em, expira_em FROM empresas ORDER BY criado_em DESC');
        res.json(empresas);
    }
    catch (error) {
        console.error('Erro ao listar empresas:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});
app.get('/api/admin/reviews', autenticarToken, async (_req, res) => {
    try {
        const reviews = await db.all(`SELECT r.*, e.nome_empresa AS empresa_nome
       FROM reviews r LEFT JOIN empresas e ON e.id = r.empresa_id
       ORDER BY r.createdAt DESC LIMIT 100`);
        res.json(reviews.map((r) => ({
            ...r,
            ai_tags: r.ai_tags ? safeParseTags(r.ai_tags) : [],
        })));
    }
    catch (error) {
        console.error('Erro ao listar reviews:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});
app.get('/api/admin/overview', autenticarToken, async (_req, res) => {
    try {
        const empresas = await db.all(`
            SELECT e.id, e.nome_empresa, e.cnpj, e.plan, e.status, e.expira_em,
              (SELECT COUNT(*) FROM reviews r WHERE r.empresa_id = e.id) AS total_reviews,
              (SELECT COALESCE(SUM(u.tokens), 0) FROM ai_usage u WHERE u.empresa_id = e.id) AS tokens_ia
      FROM empresas e
      ORDER BY e.criado_em DESC
    `);
        const usoGeral = await db.get('SELECT COALESCE(SUM(tokens), 0) AS tokens FROM ai_usage');
        const limites = { inicial: 150, pro: 400, ultra: 800, corporativo: 3500, corporate: 3500, rei: 10000, trial: 30 };
        const clientes = empresas.map((empresa) => {
            const limite = limites[String(empresa.plan || 'trial').toLowerCase()] || limites.trial;
            const percentual = Math.min(100, Math.round((Number(empresa.total_reviews) / limite) * 100));
            const expirado = empresa.status === 'trial' && empresa.expira_em && new Date(empresa.expira_em) < new Date();
            return { ...empresa, status: expirado ? 'inadimplente' : empresa.status, percentual_uso: percentual, alerta_upgrade: percentual >= 80 };
        });
        const novos7 = await db.get("SELECT COUNT(*) AS total FROM empresas WHERE datetime(criado_em) >= datetime('now', '-7 days')");
        const novosMes = await db.get("SELECT COUNT(*) AS total FROM empresas WHERE strftime('%Y-%m', criado_em) = strftime('%Y-%m', 'now')");
        const inadimplentes = clientes.filter((empresa) => empresa.status === 'inadimplente').length;
        res.json({
            financeiro: { faturamento_global: 0, faturas_vencidas: 0, novos_7_dias: Number(novos7.total), novos_mes: Number(novosMes.total) },
            clientes,
            ia: { tokens_total: Number(usoGeral.tokens), top10: clientes.sort((a, b) => b.tokens_ia - a.tokens_ia).slice(0, 10), alertas: clientes.filter((empresa) => empresa.alerta_upgrade) },
            inadimplentes,
        });
    }
    catch (error) {
        console.error('Erro no overview administrativo:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});
app.post('/api/admin/trocar-senha', autenticarToken, async (req, res) => {
    const { senhaAtual, novaSenha } = req.body;
    if (!senhaAtual || !novaSenha)
        return res.status(400).json({ error: 'Senha atual e nova senha são obrigatórias.' });
    if (novaSenha.length < 8)
        return res.status(400).json({ error: 'A nova senha deve ter pelo menos 8 caracteres.' });
    if (!/\d/.test(novaSenha))
        return res.status(400).json({ error: 'A nova senha deve conter pelo menos um número.' });
    try {
        const usuario = await db.get('SELECT * FROM usuarios WHERE id = ?', [req.user?.id]);
        if (!usuario)
            return res.status(404).json({ error: 'Usuário não encontrado.' });
        const senhaCorreta = await bcrypt.compare(senhaAtual, usuario.senha_hash);
        if (!senhaCorreta)
            return res.status(401).json({ error: 'Senha atual incorreta.' });
        const novoHash = await bcrypt.hash(novaSenha, 10);
        await db.run('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [novoHash, req.user?.id]);
        res.json({ success: true, message: 'Senha alterada com sucesso.' });
    }
    catch (error) {
        console.error('Erro ao trocar senha:', error);
        res.status(500).json({ error: 'Erro interno do servidor.' });
    }
});
const PORT = process.env.PORT || 5000;
async function main() {
    try {
        await initDB();
        mountPasswordResetRoutes(app, () => db);
        mountStripeRoutes(app, () => db);
        console.log('🔑 Recuperação de senha: on');
        console.log(`💳 Stripe: ${stripeConfigured() ? 'ok' : 'off (defina STRIPE_SECRET_KEY)'}`);
        app.listen(PORT, () => console.log(`🚀 Servidor em http://localhost:${PORT}`));
    }
    catch (error) {
        console.error('❌ Falha ao iniciar:', error);
        process.exit(1);
    }
}
main();
function montarWhatsAppLink(arg0, key) {
    const modo = String(arg0 || 'trial').trim();
    const empresaKey = String(key || '').trim();
    const linkAvaliacao = `${APP_URL}/avaliacao/${encodeURIComponent(empresaKey)}`;
    const mensagem = modo === 'trial'
        ? `Olá! Gostaria de falar sobre o atendimento da empresa. Link para avaliação: ${linkAvaliacao}`
        : `Olá! Preciso de ajuda com o atendimento da empresa. Link: ${linkAvaliacao}`;
    return `https://wa.me/?text=${encodeURIComponent(mensagem)}`;
}
function fileURLToPath(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') {
        throw new TypeError(`Esperada uma URL file:, recebido ${parsed.protocol}`);
    }
    const pathname = decodeURIComponent(parsed.pathname);
    if (process.platform === 'win32') {
        if (parsed.hostname && parsed.hostname !== 'localhost') {
            return `\\\\${parsed.hostname}${pathname.replace(/\//g, '\\')}`;
        }
        return pathname.replace(/^\/[a-zA-Z]:/, (drive) => drive.slice(1)).replace(/\//g, '\\');
    }
    if (parsed.hostname && parsed.hostname !== 'localhost') {
        return `//${parsed.hostname}${pathname}`;
    }
    return pathname;
}
async function callGroq(systemContent, userContent) {
    const chave = crypto.createHash('sha256').update(`${systemContent}\n${userContent}`).digest('hex');
    exigirIntervaloIA(chave);
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey)
        throw new Error('Chave GROQ_API_KEY não configurada no arquivo .env');
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
            messages: [
                { role: 'system', content: systemContent },
                { role: 'user', content: userContent },
            ],
            max_tokens: 150,
            temperature: 0.7,
        }),
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq API error ${response.status}: ${errText}`);
    }
    const data = await response.json();
    return data.choices[0].message.content;
}
export async function gerarTagsSemanticas(comentario) {
    const systemPrompt = 'Você é um analista de pós-venda. Extraia até 3 tags semânticas curtas deste feedback (ex: Demora, Comida Fria, Mau Atendimento). Responda apenas com as palavras separadas por vírgula.';
    try {
        return await callGroq(systemPrompt, comentario);
    }
    catch (error) {
        console.error('Falha ao gerar tags semânticas:', error);
        return 'Geral';
    }
}
async function gerarRelatorioMensalPDF(empresaId, mesAno, planoPreview, demo = false) {
    let empresa = await db.get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
    if (!empresa)
        throw new Error('Empresa não encontrada.');
    if (empresa.empresa_pai_id) {
        const empresaMae = await db.get('SELECT * FROM empresas WHERE id = ?', [empresa.empresa_pai_id]);
        if (empresaMae)
            empresa = empresaMae;
    }
    const planoTesteSelecionado = obterPlanoTeste(planoPreview);
    const plano = planoTesteSelecionado || String(empresa.plan || 'Inicial').toLowerCase();
    if (!planoTesteSelecionado && !['pro', 'ultra', 'corporate', 'corporativo', 'rei'].includes(plano)) {
        throw new Error('Plano não elegível para relatório mensal.');
    }
    const empresasRelatorio = ['corporate', 'corporativo', 'rei'].includes(plano)
        ? await db.all(`SELECT * FROM empresas WHERE id = ? OR empresa_pai_id = ? ORDER BY id = ? DESC, nome_empresa`, [empresa.id, empresa.id, empresa.id])
        : [empresa];
    const idsRelatorio = empresasRelatorio.map((unidade) => unidade.id);
    const placeholders = idsRelatorio.map(() => '?').join(', ');
    let reviews = await db.all(`SELECT rating, comment, empresa_id, createdAt FROM reviews
     WHERE empresa_id IN (${placeholders})
       AND strftime('%Y-%m', createdAt) = ?`, [...idsRelatorio, mesAno]);
    if (demo && process.env.NODE_ENV !== 'production') {
        const exemplos = [
            [5, 'Atendimento excelente e equipe muito atenciosa.'],
            [4, 'Boa experiencia, com pequena demora no horario de pico.'],
            [5, 'Ambiente organizado e produto de otima qualidade.'],
            [3, 'A fila estava longa e faltou informacao sobre o prazo.'],
            [2, 'Pedido chegou frio e a troca demorou mais que o esperado.'],
            [4, 'Problema pontual resolvido rapidamente pela equipe.'],
            [5, 'Experiencia muito positiva, voltarei novamente.'],
            [3, 'A cobranca precisou de uma correcao no caixa.'],
            [2, 'Pedido incompleto e retorno do suporte demorou.'],
            [5, 'Servico consistente e ambiente impecavel.'],
            [4, 'Entrega correta, mas poderia ser mais rapida.'],
            [5, 'Equipe preparada e atendimento profissional.'],
        ];
        const quantidade = plano === 'pro' ? 8 : plano === 'ultra' ? 12 : plano === 'corporativo' || plano === 'corporate' ? 18 : 24;
        reviews = Array.from({ length: quantidade }, (_, index) => {
            const exemplo = exemplos[index % exemplos.length];
            return { rating: exemplo[0], comment: `${exemplo[1]} [DEMO]`, empresa_id: empresa.id };
        });
    }
    const criticasRetidas = reviews.filter((r) => r.rating <= 3).length;
    const totalAvaliacoes = reviews.length;
    const notaMedia = totalAvaliacoes > 0
        ? reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / totalAvaliacoes
        : 0;
    const distribuicaoNotas = Array.from({ length: 5 }, (_, index) => ({
        rating: index + 1,
        total: reviews.filter((review) => Number(review.rating) === index + 1).length,
    }));
    const tendenciaSemanal = Array.from({ length: 4 }, (_, index) => {
        const semana = index + 1;
        const semanaReviews = reviews.filter((review) => {
            const dia = Number(String(review.createdAt || '').slice(8, 10));
            return dia >= (semana - 1) * 7 + 1 && dia <= semana * 7;
        });
        return {
            label: `Sem ${semana}`,
            total: semanaReviews.length,
            media: semanaReviews.length > 0
                ? semanaReviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / semanaReviews.length
                : 0,
            negativas: semanaReviews.filter((review) => Number(review.rating) <= 3).length,
        };
    });
    const unidadesAnalise = empresasRelatorio.length > 1
        ? empresasRelatorio.map((unidade) => ({
            nome: unidade.nome_empresa,
            reviews: reviews.filter((review) => review.empresa_id === unidade.id),
        }))
        : demo && (plano === 'corporativo' || plano === 'corporate' || plano === 'rei')
            ? ['Filial Centro', 'Filial Shopping', 'Filial Norte'].map((nome, index) => ({
                nome,
                reviews: reviews.filter((_, reviewIndex) => reviewIndex % 3 === index),
            }))
            : [];
    const BATCH_SIZE = 2000;
    const batches = [];
    for (let i = 0; i < reviews.length; i += BATCH_SIZE) {
        const slice = reviews.slice(i, i + BATCH_SIZE);
        const comentarios = slice
            .map((r) => r.comment?.trim())
            .filter(Boolean)
            .join('\n');
        batches.push(comentarios);
    }
    const systemPrompt = `Você é um analista de experiência do cliente.
Analise o bloco de comentários abaixo e devolva, em JSON simples, dois campos:
1. "sentimento": "positivo" | "negativo" | "neutro"
2. "gargalos": lista de até 5 tópicos recorrentes (ex.: "tempo de espera", "produto frio")`;
    const resultados = [];
    if (demo || plano === 'inicial' || plano === 'pro' || batches.length === 0) {
        resultados.push({ sentimento: 'positivo', gargalos: ['tempo de espera', 'comunicacao operacional'] });
    }
    else if (plano === 'inicial' || batches.length === 0) {
        resultados.push({ sentimento: 'sem dados', gargalos: [] });
    }
    else {
        for (const batch of batches) {
            try {
                const resposta = await callGroq(systemPrompt, batch);
                resultados.push(JSON.parse(resposta));
            }
            catch {
                resultados.push({ sentimento: 'indefinido', gargalos: [] });
            }
        }
    }
    const sentimentoContagem = {};
    const gargaloContagem = {};
    for (const r of resultados) {
        sentimentoContagem[r.sentimento] = (sentimentoContagem[r.sentimento] ?? 0) + 1;
        for (const g of Array.isArray(r.gargalos) ? r.gargalos : []) {
            gargaloContagem[g] = (gargaloContagem[g] ?? 0) + 1;
        }
    }
    const sentimentoPrincipal = Object.entries(sentimentoContagem).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'indefinido';
    const topGargalos = Object.entries(gargaloContagem)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([g]) => g);
    const [ano, mes] = mesAno.split('-');
    const nomesMeses = [
        'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
        'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
    ];
    const periodoFormatado = ano && Number(mes) >= 1 && Number(mes) <= 12
        ? `${nomesMeses[Number(mes) - 1]} / ${ano}`
        : mesAno;
    const emissaoFormatada = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(new Date());
    const sentimentoTexto = sentimentoPrincipal === 'sem dados'
        ? 'Análise suspensa. Razão: Amostragem insuficiente de dados no período selecionado.'
        : sentimentoPrincipal;
    const gargalosTexto = topGargalos.length > 0
        ? topGargalos.join(', ')
        : 'Nenhum ponto de atrito crítico detectado nos canais de atendimento e produto até o momento.';
    const doc = new PDFDocument({
        size: 'A4',
        margin: 42,
        bufferPages: true,
        info: { Title: `${empresa.nome_empresa} - Relatório Mensal ${mesAno}` },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const navy = '#17233c';
    const blue = '#2d5b9f';
    const ink = '#26364d';
    const muted = '#65748a';
    const line = '#d9e1eb';
    const paleBlue = '#edf3fa';
    const paleGray = '#f5f7fa';
    const drawWatermark = () => {
        const centerX = doc.page.width / 2;
        const centerY = doc.page.height / 2;
        doc.save();
        doc.opacity(0.03);
        doc.fillColor(navy).font('Helvetica-Bold').fontSize(54);
        doc.rotate(-45, { origin: [centerX, centerY] });
        doc.text('FILTRA.IA', centerX - 180, centerY - 27, {
            width: 360,
            align: 'center',
            lineBreak: false,
        });
        doc.restore();
    };
    const sectionTitle = (title, subtitle) => {
        doc.fillColor(navy).fontSize(13).font('Helvetica-Bold').text(title);
        doc.moveDown(0.2).fillColor(muted).fontSize(8.5).font('Helvetica').text(subtitle);
        doc.moveDown(0.55);
    };
    const drawKpi = (title, value, description, x, y, width) => {
        doc.roundedRect(x, y, width, 86, 6).fillAndStroke(paleGray, line);
        doc.fillColor(blue).fontSize(8).font('Helvetica-Bold').text(title.toUpperCase(), x + 12, y + 12, { width: width - 24 });
        doc.fillColor(navy).fontSize(16).font('Helvetica-Bold').text(value, x + 12, y + 29, { width: width - 24 });
        doc.fillColor(muted).fontSize(8.5).font('Helvetica').text(description, x + 12, y + 57, { width: width - 24, lineGap: 1.5 });
    };
    const drawHorizontalBars = (title, items, y) => {
        doc.fillColor(navy).fontSize(12).font('Helvetica-Bold').text(title, 42, y);
        const maxValue = Math.max(...items.map((item) => item.value), 1);
        items.forEach((item, index) => {
            const rowY = y + 25 + index * 25;
            doc.fillColor(muted).fontSize(8.5).font('Helvetica').text(item.label, 42, rowY + 2, { width: 85 });
            doc.roundedRect(132, rowY, pageWidth - 190, 12, 3).fill('#e8edf3');
            doc.roundedRect(132, rowY, Math.max(3, (pageWidth - 190) * item.value / maxValue), 12, 3).fill(item.color);
            doc.fillColor(ink).fontSize(8.5).text(String(item.value), pageWidth - 48, rowY + 2, { width: 30, align: 'right' });
        });
    };
    const drawTrend = (y) => {
        const chartWidth = pageWidth - 45;
        const chartHeight = 110;
        const originX = 62;
        const originY = y + chartHeight;
        const maxValue = Math.max(...tendenciaSemanal.map((item) => item.total), 1);
        doc.fillColor(navy).fontSize(12).font('Helvetica-Bold').text('Evolução semanal do volume', 42, y);
        doc.strokeColor(line).lineWidth(0.7).moveTo(originX, y + 10).lineTo(originX, originY).lineTo(originX + chartWidth, originY).stroke();
        tendenciaSemanal.forEach((item, index) => {
            const x = originX + 25 + index * ((chartWidth - 45) / 3);
            const pointY = originY - (item.total / maxValue) * 82;
            doc.strokeColor('#d7e0ea').lineWidth(0.5).moveTo(x, originY).lineTo(x, y + 10).stroke();
            doc.fillColor(blue).circle(x, pointY, 4).fill();
            if (index > 0) {
                const previous = tendenciaSemanal[index - 1];
                const previousX = originX + 25 + (index - 1) * ((chartWidth - 45) / 3);
                const previousY = originY - (previous.total / maxValue) * 82;
                doc.strokeColor(blue).lineWidth(2).moveTo(previousX, previousY).lineTo(x, pointY).stroke();
            }
            doc.fillColor(ink).fontSize(8).text(String(item.total), x - 10, pointY - 16, { width: 20, align: 'center' });
            doc.fillColor(muted).fontSize(8).text(item.label, x - 20, originY + 8, { width: 40, align: 'center' });
        });
    };
    doc.rect(0, 0, doc.page.width, 76).fill(navy);
    doc.fillColor('#ffffff').fontSize(18).font('Helvetica-Bold').text('FILTRA.IA', 42, 22, { continued: true });
    doc.font('Helvetica').fontSize(10).text('  — Sistema Inteligente de Gestão');
    doc.fillColor('#c9d8ed').fontSize(8.5).font('Helvetica').text('RELATÓRIO EXECUTIVO DE EXPERIÊNCIA DO CLIENTE', 42, 51);
    doc.y = 100;
    sectionTitle('Identificação do relatório', 'Informações cadastrais e período de apuração');
    const metaY = doc.y;
    const metaHeight = 66;
    doc.roundedRect(42, metaY, pageWidth, metaHeight, 6).fillAndStroke(paleBlue, line);
    const metaColumns = [
        ['Empresa cliente', String(empresa.nome_empresa)],
        ['CNPJ', String(empresa.cnpj || 'Não informado')],
        ['Período de apuração', periodoFormatado],
        ['Emissão', emissaoFormatada],
    ];
    const metaWidth = pageWidth / metaColumns.length;
    metaColumns.forEach(([label, value], index) => {
        const x = 54 + index * metaWidth;
        doc.fillColor(muted).fontSize(7.5).font('Helvetica-Bold').text(label.toUpperCase(), x, metaY + 14, { width: metaWidth - 18 });
        doc.fillColor(ink).fontSize(9.5).font('Helvetica').text(value, x, metaY + 31, { width: metaWidth - 18, lineGap: 1.5 });
    });
    doc.y = metaY + metaHeight + 28;
    sectionTitle('Painel executivo de métricas', 'Indicadores consolidados para leitura rápida da operação');
    const kpiGap = 10;
    const kpiWidth = (pageWidth - kpiGap * 2) / 3;
    const kpiY = doc.y;
    drawKpi('Volume geral de interações', `${totalAvaliacoes} avaliações`, `${totalAvaliacoes} avaliações registradas no período.`, 42, kpiY, kpiWidth);
    drawKpi('Índice de satisfação do cliente', `${notaMedia.toFixed(1)} / 5.0`, totalAvaliacoes > 0 ? 'Score médio calculado sobre a amostra disponível.' : 'Aguardando dados de amostragem.', 42 + kpiWidth + kpiGap, kpiY, kpiWidth);
    drawKpi('Escudo de marca', `${criticasRetidas} críticas`, `${criticasRetidas} reclamações retidas internamente no fluxo privado.`, 42 + (kpiWidth + kpiGap) * 2, kpiY, kpiWidth);
    doc.y = kpiY + 112;
    sectionTitle('Distribuição de satisfação', 'Leitura visual da concentração de notas no período');
    const chartY = doc.y;
    const chartHeight = 105;
    doc.roundedRect(42, chartY, pageWidth, chartHeight, 6).fillAndStroke('#ffffff', line);
    const maxNota = Math.max(...distribuicaoNotas.map((item) => Number(item.total)), 1);
    for (let rating = 1; rating <= 5; rating += 1) {
        const item = distribuicaoNotas.find((entry) => Number(entry.rating) === rating);
        const totalNota = Number(item?.total || 0);
        const barWidth = ((pageWidth - 145) / 5) * totalNota / maxNota;
        const y = chartY + 15 + (rating - 1) * 17;
        doc.fillColor(muted).fontSize(8).font('Helvetica').text(`${rating} estrela${rating > 1 ? 's' : ''}`, 56, y + 2, { width: 55 });
        doc.roundedRect(120, y, Math.max(2, barWidth), 10, 3).fill(rating <= 3 ? '#e07a7a' : '#55a982');
        doc.fillColor(ink).fontSize(8).text(String(totalNota), 130 + Math.max(2, barWidth), y + 2);
    }
    doc.y = chartY + chartHeight + 18;
    if (['ultra', 'corporate', 'corporativo', 'rei'].includes(plano)) {
        const trendY = doc.y;
        drawTrend(trendY);
        doc.y = trendY + 145;
    }
    sectionTitle('Inteligência artificial', 'Leitura automatizada dos sinais de experiência e dos pontos de atenção');
    const aiY = doc.y;
    doc.roundedRect(42, aiY, pageWidth, 126, 6).fillAndStroke('#ffffff', line);
    doc.rect(42, aiY, 5, 126).fill(blue);
    doc.fillColor(blue).fontSize(8).font('Helvetica-Bold').text('SENTIMENTO PREDOMINANTE', 61, aiY + 17);
    doc.fillColor(ink).fontSize(10.5).font('Helvetica').text(sentimentoTexto, 61, aiY + 34, { width: pageWidth - 40, lineGap: 2 });
    doc.moveTo(61, aiY + 66).lineTo(42 + pageWidth - 20, aiY + 66).strokeColor(line).lineWidth(0.7).stroke();
    doc.fillColor(blue).fontSize(8).font('Helvetica-Bold').text('PRINCIPAIS GARGALOS OPERACIONAIS', 61, aiY + 82);
    doc.fillColor(ink).fontSize(10.5).font('Helvetica').text(gargalosTexto, 61, aiY + 99, { width: pageWidth - 40, lineGap: 2 });
    doc.y = aiY + 154;
    sectionTitle('Recomendação estratégica', 'Próximo passo sugerido para a gestão');
    const recommendation = `O sistema está operacional e integrado ao seu WhatsApp Business. Divulgue o link ou exiba o QR Code no balcão/mesas para iniciar a coleta automática de feedbacks e alimentar o próximo relatório consolidado. Plano contratado: ${empresa.plan || 'trial'}.`;
    const recY = doc.y;
    doc.roundedRect(42, recY, pageWidth, 76, 6).fillAndStroke(paleBlue, line);
    doc.fillColor(navy).fontSize(9.5).font('Helvetica-Bold').text('Recomendação Estratégica:', 56, recY + 16);
    doc.fillColor(ink).fontSize(9.5).font('Helvetica').text(recommendation, 56, recY + 33, { width: pageWidth - 28, lineGap: 2.5 });
    if (['corporate', 'corporativo', 'rei'].includes(plano)) {
        doc.addPage();
        doc.fillColor(navy).fontSize(18).font('Helvetica-Bold').text('FILTRA.IA');
        doc.moveDown(0.25).fillColor(muted).fontSize(9).font('Helvetica').text('ANÁLISE DE GOVERNANÇA E PERFORMANCE');
        doc.moveDown(1).fillColor(ink).fontSize(16).font('Helvetica-Bold').text('Visão comparativa das unidades');
        doc.moveDown(0.3).fillColor(muted).fontSize(9.5).font('Helvetica').text(`Consolidação do grupo para ${periodoFormatado}`);
        doc.moveDown(1.4);
        const ranking = unidadesAnalise.map((unidade) => {
            const total = unidade.reviews.length;
            const media = total > 0 ? unidade.reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / total : 0;
            return { nome: unidade.nome, total, media, negativas: unidade.reviews.filter((review) => Number(review.rating) <= 3).length };
        }).sort((a, b) => b.media - a.media);
        drawHorizontalBars('Ranking de satisfação por unidade', ranking.map((item) => ({ label: item.nome.slice(0, 14), value: Math.round(item.media * 10) / 10, color: '#55a982' })), doc.y);
        doc.y += 125;
        drawHorizontalBars('Volume de feedbacks por unidade', ranking.map((item) => ({ label: item.nome.slice(0, 14), value: item.total, color: blue })), doc.y);
        doc.y += 125;
        doc.fillColor(navy).fontSize(12).font('Helvetica-Bold').text('Matriz de atenção operacional', 42, doc.y);
        doc.moveDown(0.6).fillColor(ink).fontSize(9.5).font('Helvetica');
        ranking.forEach((item) => {
            const nivel = item.negativas >= 3 ? 'Atenção prioritária' : item.negativas > 0 ? 'Acompanhamento recomendado' : 'Operação estável';
            doc.text(`${item.nome}: ${nivel} (${item.negativas} críticas interceptadas).`, { width: pageWidth, lineGap: 3 });
        });
        if (plano === 'rei') {
            doc.moveDown(1.3).fillColor(navy).fontSize(12).font('Helvetica-Bold').text('Governança REI');
            doc.moveDown(0.5).fillColor(muted).fontSize(9.5).font('Helvetica').text('A camada REI reúne a leitura global, o ranking comparativo e a auditoria individual das unidades. Use a evolução semanal para priorizar recursos, treinamento e ações corretivas por praça.', { width: pageWidth, lineGap: 3 });
        }
    }
    for (const unidade of empresasRelatorio.slice(1)) {
        const reviewsUnidade = reviews.filter((review) => review.empresa_id === unidade.id);
        const totalUnidade = reviewsUnidade.length;
        const mediaUnidade = totalUnidade > 0
            ? reviewsUnidade.reduce((sum, review) => sum + Number(review.rating || 0), 0) / totalUnidade
            : 0;
        const negativasUnidade = reviewsUnidade.filter((review) => Number(review.rating) <= 3).length;
        doc.addPage();
        doc.fillColor(navy).fontSize(18).font('Helvetica-Bold').text('FILTRA.IA');
        doc.moveDown(0.25).fillColor(muted).fontSize(9).font('Helvetica').text('RELATÓRIO POR UNIDADE');
        doc.moveDown(1).fillColor(ink).fontSize(17).font('Helvetica-Bold').text(unidade.nome_empresa);
        doc.moveDown(0.25).fillColor(muted).fontSize(10).font('Helvetica').text(`Período de apuração: ${periodoFormatado}`);
        doc.moveDown(1);
        doc.moveTo(42, doc.y).lineTo(42 + pageWidth, doc.y).strokeColor(line).stroke();
        doc.moveDown(1);
        doc.fillColor(navy).fontSize(13).font('Helvetica-Bold').text('Indicadores da unidade');
        doc.moveDown(0.6);
        doc.fillColor(ink).fontSize(11).font('Helvetica')
            .text(`Volume geral de interações: ${totalUnidade} avaliações registradas.`)
            .moveDown(0.5)
            .text(`Índice de satisfação do cliente: ${mediaUnidade.toFixed(1)} / 5.0.`)
            .moveDown(0.5)
            .text(`Escudo de marca: ${negativasUnidade} reclamações retidas internamente no fluxo privado.`);
        doc.moveDown(1.5);
        doc.fillColor(navy).fontSize(13).font('Helvetica-Bold').text('Análise da unidade');
        doc.moveDown(0.6).fillColor(muted).fontSize(10).font('Helvetica').text(totalUnidade > 0
            ? 'Os indicadores desta unidade foram calculados exclusivamente com os resultados disponíveis no período selecionado.'
            : 'Nenhuma avaliação foi registrada para esta unidade no período selecionado.');
        doc.moveDown(2);
        doc.fillColor(blue).fontSize(10).font('Helvetica-Bold').text('RECOMENDAÇÃO');
        doc.moveDown(0.35).fillColor(ink).fontSize(10).font('Helvetica').text('Mantenha o QR Code visível na unidade para ampliar a amostragem e permitir análises mais representativas nos próximos períodos.', { width: pageWidth, lineGap: 3 });
    }
    await new Promise((resolve, reject) => {
        doc.on('end', resolve);
        doc.on('error', reject);
        const range = doc.bufferedPageRange();
        for (let pageIndex = range.start; pageIndex < range.start + range.count; pageIndex += 1) {
            doc.switchToPage(pageIndex);
            drawWatermark();
            doc.fillColor(muted).fontSize(7.5).font('Helvetica').text(`© 2026 FILTRA.IA. Propriedade intelectual e dados analíticos protegidos. Uso exclusivo de ${empresa.nome_empresa}.`, 42, doc.page.height - 38, { width: pageWidth, align: 'center' });
        }
        doc.switchToPage(range.start + range.count - 1);
        doc.flushPages();
        doc.end();
    });
    return Buffer.concat(chunks);
}
app.post('/api/relatorio/mensal', async (req, res) => {
    try {
        const empresaId = req.body.empresaId ?? req.body.empresa_id;
        const mesAno = req.body.mesAno ?? req.body.mes_ano;
        const planoPreview = obterPlanoTeste(req.body.previewPlan);
        const demo = req.body.demo === true;
        if (typeof empresaId !== 'string' || typeof mesAno !== 'string') {
            return res.status(400).json({ error: 'empresaId e mesAno são obrigatórios.' });
        }
        const pdf = await gerarRelatorioMensalPDF(empresaId, mesAno, planoPreview || undefined, demo);
        res.type('application/pdf').send(pdf);
    }
    catch (error) {
        console.error('Erro ao gerar relatório:', error);
        if (error instanceof Error && error.message === 'Plano não elegível para relatório mensal.') {
            return res.status(403).json({ error: error.message });
        }
        return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
});
async function gerarRespostaReview(name, rating, comment, nomeEmpresa, voiceStyle) {
    const local = nomeEmpresa ? ` do estabelecimento "${nomeEmpresa}"` : '';
    const estilo = voiceStyle?.trim()
        ? `\nMantenha este estilo de comunicação: ${voiceStyle.slice(0, 1500)}`
        : '';
    const system = `Você responde avaliações negativas de clientes de forma empática, profissional e breve (máximo 3 frases). Peça desculpas quando apropriado e indique que a equipe vai analisar. Não invente políticas ou promessas específicas.${estilo}`;
    const prompt = `Cliente: ${name || 'Anônimo'}\nNota: ${rating}/5\nComentário: ${comment}\n\nEscreva uma resposta curta para esta avaliação negativa${local}.`;
    return callGroq(system, prompt);
}

