import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import 'dotenv/config';
import { gerarRespostaReview, gerarTagsSemanticas } from './groqService.js';
const app = express();
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
const allowedOrigins = [process.env.FRONTEND_URL || 'http://localhost:3000'].filter(Boolean);
app.use(cors({
    origin: true,
    credentials: true,
}));
let db;
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
/** Nome da empresa → slug amigável (ex: "Pizzaria do Zé" → "pizzaria-do-ze") */
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
/** Busca empresa por UUID ou por slug */
async function findEmpresa(ref) {
    if (!ref)
        return null;
    // UUID tem hífens e 36 chars tipicamente
    const porId = await db.get('SELECT * FROM empresas WHERE id = ?', [ref]);
    if (porId)
        return porId;
    return db.get('SELECT * FROM empresas WHERE slug = ?', [ref]);
}
function linksEmpresa(slugOrId) {
    const key = slugOrId;
    return {
        avaliacao: `${APP_URL}/avaliacao/${key}`,
        painel: `${APP_URL}/painel/${key}`,
        widget: `${APP_URL}/widget/${key}`,
        embed: `<iframe src="${APP_URL}/widget/${key}" width="100%" height="420" frameborder="0" style="border:0;border-radius:12px;" title="Avaliações"></iframe>`,
    };
}
async function initDB() {
    db = await open({ filename: './database.sqlite', driver: sqlite3.Database });
    await db.exec(`
    CREATE TABLE IF NOT EXISTS empresas (
      id TEXT PRIMARY KEY,
      cnpj TEXT UNIQUE NOT NULL,
      nome_empresa TEXT NOT NULL,
      slug TEXT UNIQUE,
      status TEXT DEFAULT 'trial',
      criado_em DATETIME NOT NULL,
      expira_em DATETIME NOT NULL,
      google_review_url TEXT,
      voice_style TEXT
    );
  `);
    const colunasEmpresas = await db.all(`PRAGMA table_info(empresas)`);
    const nomes = colunasEmpresas.map((c) => c.name);
    if (!nomes.includes('google_review_url')) {
        await db.exec(`ALTER TABLE empresas ADD COLUMN google_review_url TEXT`);
    }
    if (!nomes.includes('voice_style')) {
        await db.exec(`ALTER TABLE empresas ADD COLUMN voice_style TEXT`);
    }
    if (!nomes.includes('slug')) {
        await db.exec(`ALTER TABLE empresas ADD COLUMN slug TEXT`);
    }
    // Preenche slug para empresas antigas sem slug
    const semSlug = await db.all('SELECT id, nome_empresa FROM empresas WHERE slug IS NULL OR slug = ""');
    for (const e of semSlug) {
        const base = slugify(e.nome_empresa);
        const slug = await slugUnico(base);
        await db.run('UPDATE empresas SET slug = ? WHERE id = ?', [slug, e.id]);
        console.log(`🔗 Slug gerado: ${slug} ← ${e.nome_empresa}`);
    }
    // Índice único no slug (se ainda não existir)
    try {
        await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_slug ON empresas(slug)`);
    }
    catch {
        /* ok */
    }
    await db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      senha_hash TEXT NOT NULL
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
    if (!colunasReviews.some((col) => col.name === 'ai_reply')) {
        await db.exec(`ALTER TABLE reviews ADD COLUMN ai_reply TEXT`);
    }
    if (!colunasReviews.some((col) => col.name === 'ai_tags')) {
        await db.exec(`ALTER TABLE reviews ADD COLUMN ai_tags TEXT`);
    }
    const adminExiste = await db.get('SELECT * FROM usuarios WHERE email = ?', ['admin@seusaas.com']);
    if (!adminExiste) {
        const senhaPadrao = process.env.ADMIN_PASSWORD || 'MudeEstaSenha123!';
        const hash = await bcrypt.hash(senhaPadrao, 10);
        await db.run('INSERT INTO usuarios (id, email, senha_hash) VALUES (?, ?, ?)', [
            crypto.randomUUID(),
            'admin@seusaas.com',
            hash,
        ]);
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
const JWT_SECRET = process.env.JWT_SECRET || 'segredo-dev';
if (!process.env.JWT_SECRET) {
    console.warn('⚠️ JWT_SECRET não definido! Usando segredo temporário.');
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
        req.user = jwt.verify(token, JWT_SECRET);
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
// ---- Trial ----
app.post('/api/trial/ativar', trialLimiter, async (req, res) => {
    try {
        const cnpj = normalizarCnpj(req.body.cnpj ?? '');
        const nome = String(req.body.nome_empresa ?? '').trim().slice(0, 120);
        const googleReviewUrl = String(req.body.google_review_url ?? '').trim().slice(0, 500);
        if (!cnpjValido(cnpj))
            return res.status(400).json({ error: 'CNPJ inválido.' });
        if (nome.length < 2 || nome.length > 120)
            return res.status(400).json({ error: 'Nome da empresa inválido.' });
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
            });
        }
        if (empresa.status === 'ativo' || empresa.status === 'trial') {
            return res.json({
                valido: true,
                nome: empresa.nome_empresa,
                empresa_id: empresa.id,
                slug: empresa.slug,
                google_review_url: empresa.google_review_url || null,
            });
        }
        return res.json({
            valido: false,
            motivo: 'inactive',
            nome: empresa.nome_empresa,
            empresa_id: empresa.id,
            slug: empresa.slug,
            google_review_url: empresa.google_review_url || null,
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
        const ha24h = Date.now() - 24 * 60 * 60 * 1000;
        const crisesRecentes = parsed.filter((r) => r.rating <= 2 && new Date(r.createdAt).getTime() >= ha24h).length;
        const key = empresa.slug || empresa.id;
        res.json({
            empresa: {
                id: empresa.id,
                slug: empresa.slug,
                nome_empresa: empresa.nome_empresa,
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
                negativas,
                positivas,
                alerta_crise: crisesRecentes >= 3,
                crises_24h: crisesRecentes,
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
app.post('/api/reviews', reviewsLimiter, async (req, res) => {
    const resultado = validarReview(req.body);
    if ('error' in resultado)
        return res.status(400).json({ error: resultado.error });
    const { name, rating, comment, empresa_ref } = resultado;
    try {
        let empresaId = null;
        let nomeEmpresa;
        let voiceStyle;
        if (empresa_ref) {
            const empresa = await findEmpresa(empresa_ref);
            if (empresa) {
                empresaId = empresa.id;
                nomeEmpresa = empresa.nome_empresa;
                voiceStyle = empresa.voice_style || undefined;
            }
        }
        let aiReply = null;
        let aiTags = [];
        if (process.env.GROQ_API_KEY) {
            try {
                aiTags = await gerarTagsSemanticas(rating, comment || '');
            }
            catch (e) {
                console.error('Falha ao gerar tags:', e);
            }
            if (rating <= 3 && comment) {
                try {
                    aiReply = await gerarRespostaReview(name, rating, comment, nomeEmpresa, voiceStyle);
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
// ---- Admin ----
app.post('/api/admin/login', loginLimiter, async (req, res) => {
    const { email, senha } = req.body;
    if (!email || !senha)
        return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    try {
        const usuario = await db.get('SELECT * FROM usuarios WHERE email = ?', [email]);
        if (!usuario)
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        const senhaCorreta = await bcrypt.compare(senha, usuario.senha_hash);
        if (!senhaCorreta)
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        const token = jwt.sign({ id: usuario.id, email: usuario.email }, JWT_SECRET, { expiresIn: '1d' });
        setAuthCookie(res, token);
        res.json({ success: true, user: { id: usuario.id, email: usuario.email } });
    }
    catch (error) {
        console.error('Erro no login:', error);
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
        const reviews = await db.all('SELECT * FROM reviews ORDER BY createdAt DESC LIMIT 100');
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
        app.listen(PORT, () => console.log(`🚀 Servidor em http://localhost:${PORT}`));
    }
    catch (error) {
        console.error('❌ Falha ao iniciar:', error);
        process.exit(1);
    }
}
main();
