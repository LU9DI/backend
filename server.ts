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
import type { Request, Response, NextFunction } from 'express';
import type { Database } from 'sqlite';
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
  if (req.originalUrl?.startsWith('/api/webhook/stripe')) return next();
  return express.json({ limit: '20kb' })(req, res, next);
});

const allowedOrigins = [process.env.FRONTEND_URL || 'http://localhost:3000'].filter(Boolean) as string[];
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

export let db!: Database;

const COOKIE_NAME = 'saas_auth_token';
const isProd = process.env.NODE_ENV === 'production';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

function setAuthCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearAuthCookie(res: Response) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
  });
}

function slugify(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'empresa';
}

async function slugUnico(base: string): Promise<string> {
  let slug = base;
  let n = 0;
  while (true) {
    const existe = await db.get('SELECT id FROM empresas WHERE slug = ?', [slug]);
    if (!existe) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

async function findEmpresa(ref: string) {
  if (!ref) return null;
  const porId = await db.get('SELECT * FROM empresas WHERE id = ?', [ref]);
  if (porId) return porId;
  return db.get('SELECT * FROM empresas WHERE slug = ?', [ref]);
}

function linksEmpresa(slugOrId: string, plan: string = 'trial') {
  const key = slugOrId;
  return {
    avaliacao: `${APP_URL}/avaliacao/${key}`,
    painel: `${APP_URL}/painel/${key}`,
    widget: `${APP_URL}/widget/${key}`,
    embed: `<iframe src="${APP_URL}/widget/${key}" width="100%" height="420" frameborder="0" style="border:0;border-radius:12px;" title="Avaliações"></iframe>`,
    whatsapp: montarWhatsAppLink(plan, key),
  };
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
      voice_style TEXT
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
  const nomes = colunasEmpresas.map((c: any) => c.name);
  if (!nomes.includes('google_review_url')) await db.exec(`ALTER TABLE empresas ADD COLUMN google_review_url TEXT`);
  if (!nomes.includes('voice_style')) await db.exec(`ALTER TABLE empresas ADD COLUMN voice_style TEXT`);
  if (!nomes.includes('slug')) await db.exec(`ALTER TABLE empresas ADD COLUMN slug TEXT`);
  if (!nomes.includes('plan')) await db.exec(`ALTER TABLE empresas ADD COLUMN plan TEXT DEFAULT 'trial'`);
  if (!nomes.includes('whatsapp_suporte')) await db.exec(`ALTER TABLE empresas ADD COLUMN whatsapp_suporte TEXT`);

  const semSlug = await db.all('SELECT id, nome_empresa FROM empresas WHERE slug IS NULL OR slug = ""');
  for (const e of semSlug) {
    const base = slugify(e.nome_empresa);
    const slug = await slugUnico(base);
    await db.run('UPDATE empresas SET slug = ? WHERE id = ?', [slug, e.id]);
    console.log(`🔗 Slug gerado: ${slug} ← ${e.nome_empresa}`);
  }

  try {
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_slug ON empresas(slug)`);
  } catch { /* ok */ }

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
  if (!colunasReviews.some((col: any) => col.name === 'ai_reply')) await db.exec(`ALTER TABLE reviews ADD COLUMN ai_reply TEXT`);
  if (!colunasReviews.some((col: any) => col.name === 'ai_tags')) await db.exec(`ALTER TABLE reviews ADD COLUMN ai_tags TEXT`);

  await ensureAuthColumns(db);

  const adminExiste = await db.get('SELECT * FROM usuarios WHERE email = ?', ['admin@seusaas.com']);
  if (!adminExiste) {
    const senhaPadrao = process.env.ADMIN_PASSWORD || 'MudeEstaSenha123!';
    const hash = await bcrypt.hash(senhaPadrao, 10);
    await db.run(
      'INSERT INTO usuarios (id, cnpj, nome_funcionario, empresa_id, senha_hash, email) VALUES (?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), '00000000000000', 'Admin', 'admin', hash, 'admin@seusaas.com']
    );
    console.log('🔑 Admin padrão criado. Altere a senha após o primeiro login.');
  }
}

function normalizarCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, '');
}

function cnpjValido(cnpj: string): boolean {
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;
  const calcularDigito = (base: string, pesoInicial: number): number => {
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

function validarReview(body: any): { name: string; rating: number; comment: string; empresa_ref?: string } | { error: string } {
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

function safeParseTags(raw: string): string[] {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

interface AuthRequest extends Request {
  user?: { id: string; nome_funcionario: string; empresa_id: string };
}

const JWT_SECRET: string = process.env.JWT_SECRET ?? '';
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET não definido. Encerrando o servidor.');
  process.exit(1);
}

function extrairToken(req: Request): string | null {
  const fromCookie = req.cookies?.[COOKIE_NAME];
  if (fromCookie) return fromCookie;
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  return null;
}

function autenticarToken(req: AuthRequest, res: Response, next: NextFunction) {
  const token = extrairToken(req);
  if (!token) return res.status(401).json({ error: 'Token não fornecido.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    req.user = {
      id: payload.id,
      nome_funcionario: payload.nome_funcionario,
      empresa_id: payload.empresa_id,
    };
    next();
  } catch {
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

// ---- Trial (CNPJ + e-mail + senha, sem cartão) ----
app.post('/api/trial/ativar', trialLimiter, async (req: Request, res: Response) => {
  try {
    const cnpj = normalizarCnpj(req.body.cnpj ?? '');
    const nome = String(req.body.nome_empresa ?? '').trim().slice(0, 120);
    const googleReviewUrl = String(req.body.google_review_url ?? '').trim().slice(0, 500);
    const email = String(req.body.email ?? '').trim().toLowerCase();
    const senha = String(req.body.senha ?? '');

    if (!cnpjValido(cnpj)) return res.status(400).json({ error: 'CNPJ inválido.' });
    if (nome.length < 2 || nome.length > 120) return res.status(400).json({ error: 'Nome da empresa inválido.' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'E-mail inválido.' });
    }
    if (senha.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
    if (googleReviewUrl && !/^https?:\/\//i.test(googleReviewUrl)) {
      return res.status(400).json({ error: 'URL do Google Reviews inválida.' });
    }

    const id = crypto.randomUUID();
    const slug = await slugUnico(slugify(nome));
    const criadoEm = new Date();
    const expiraEm = new Date(criadoEm.getTime() + 7 * 24 * 60 * 60 * 1000);

    try {
      await db.run(
        `INSERT INTO empresas (id, cnpj, nome_empresa, slug, google_review_url, criado_em, expira_em)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, cnpj, nome, slug, googleReviewUrl || null, criadoEm.toISOString(), expiraEm.toISOString()]
      );
    } catch (e: any) {
      if (e.code === 'SQLITE_CONSTRAINT') {
        return res.status(409).json({ error: 'Este CNPJ já ativou o período de testes.' });
      }
      throw e;
    }

    try {
      await createUsuarioForEmpresa(db, { empresaId: id, cnpj, nome, email, senha });
    } catch (e: any) {
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
  } catch (error) {
    console.error('Erro ao ativar trial:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

app.get('/api/empresa/:ref/validar', async (req: Request, res: Response) => {
  try {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ valido: false, motivo: 'not_found' });

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
  } catch (error) {
    console.error('Erro ao validar:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

app.get('/api/empresa/:ref/widget', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 6, 20);
  try {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

    const reviews = await db.all(
      `SELECT name, rating, comment, createdAt FROM reviews
       WHERE empresa_id = ? AND rating >= 4 AND comment IS NOT NULL AND TRIM(comment) != ''
       ORDER BY createdAt DESC LIMIT ?`,
      [empresa.id, limit]
    );

    res.json({
      empresa: { id: empresa.id, slug: empresa.slug, nome: empresa.nome_empresa },
      reviews,
    });
  } catch (error) {
    console.error('Erro no widget:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

app.get('/api/empresa/:ref/painel', async (req: Request, res: Response) => {
  try {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });

    const reviews = await db.all(
      'SELECT * FROM reviews WHERE empresa_id = ? ORDER BY createdAt DESC LIMIT 200',
      [empresa.id]
    );

    const parsed = reviews.map((r: any) => ({
      ...r,
      ai_tags: r.ai_tags ? safeParseTags(r.ai_tags) : [],
    }));

    const total = parsed.length;
    const media = total > 0 ? parsed.reduce((s: number, r: any) => s + r.rating, 0) / total : 0;
    const negativas = parsed.filter((r: any) => r.rating <= 3).length;
    const positivas = parsed.filter((r: any) => r.rating >= 4).length;

    const oldestCurrent = parsed[parsed.length - 1]?.createdAt;
    let prevTotal = 0;
    let prevMedia = 0;
    let evolucaoPercentual = 0;
    if (oldestCurrent) {
      const previous = await db.all(
        `SELECT * FROM reviews WHERE empresa_id = ? AND createdAt < ? ORDER BY createdAt DESC LIMIT ?`,
        [empresa.id, oldestCurrent, total]
      );
      prevTotal = previous.length;
      const prevSum = previous.reduce((s: number, r: any) => s + r.rating, 0);
      prevMedia = prevTotal > 0 ? prevSum / prevTotal : 0;
      evolucaoPercentual = prevMedia === 0 ? 0 : ((media - prevMedia) / prevMedia) * 100;
    }

    const ha24h = Date.now() - 24 * 60 * 60 * 1000;
    const crisesRecentes = parsed.filter(
      (r: any) => r.rating <= 2 && new Date(r.createdAt).getTime() >= ha24h
    ).length;

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
        prevTotal,
        prevMedia: Math.round(prevMedia * 10) / 10,
        evolucao_percentual: Math.round(evolucaoPercentual * 10) / 10,
        negativas,
        positivas,
        alerta_crise: crisesRecentes >= 3,
        crises_24h: crisesRecentes,
      },
      links: linksEmpresa(key),
    });
  } catch (error) {
    console.error('Erro no painel:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

app.put('/api/empresa/:ref/voice-style', async (req: Request, res: Response) => {
  const voiceStyle = String(req.body.voice_style ?? '').trim().slice(0, 3000);
  try {
    const empresa = await findEmpresa(req.params.ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    await db.run('UPDATE empresas SET voice_style = ? WHERE id = ?', [voiceStyle || null, empresa.id]);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao salvar voice_style:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

app.post('/api/whatsapp_suporte', async (req: Request, res: Response) => {
  const { empresa_ref, numero } = req.body;
  if (!numero) return res.status(400).json({ error: 'Número de WhatsApp é obrigatório.' });
  const cleaned = String(numero).replace(/\D/g, '');
  if (cleaned.length < 10) return res.status(400).json({ error: 'Número de WhatsApp inválido.' });
  try {
    const empresa = await findEmpresa(empresa_ref);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada.' });
    await db.run('UPDATE empresas SET whatsapp_suporte = ? WHERE id = ?', [cleaned, empresa.id]);
    res.json({ success: true, whatsapp_suporte: cleaned });
  } catch (error) {
    console.error('Erro ao salvar whatsapp_suporte:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

app.post('/api/reviews', reviewsLimiter, async (req: Request, res: Response) => {
  const resultado = validarReview(req.body);
  if ('error' in resultado) return res.status(400).json({ error: resultado.error });

  const { name, rating, comment, empresa_ref } = resultado;

  try {
    let empresaId: string | null = null;
    let nomeEmpresa: string | undefined;
    let voiceStyle: string | undefined;
    let plan = 'trial';

    if (empresa_ref) {
      const empresa = await findEmpresa(empresa_ref);
      if (empresa) {
        empresaId = empresa.id;
        nomeEmpresa = empresa.nome_empresa;
        voiceStyle = empresa.voice_style || undefined;
        plan = (empresa as any).plan || 'trial';
      }
    }

    const limits: Record<string, number> = {
      trial: 30,
      pro: 150,
      ultra: 1000,
      corporate: Number.MAX_SAFE_INTEGER,
    };
    if (empresaId) {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const row = await db.get(
        'SELECT COUNT(*) as cnt FROM reviews WHERE empresa_id = ? AND strftime("%Y-%m", createdAt) = ?',
        [empresaId, month]
      );
      const count = row?.cnt ?? 0;
      if (count >= (limits[plan] ?? limits['trial'])) {
        return res.status(429).json({
          error: `Limite mensal de avaliações (${limits[plan]}) atingido para o plano ${plan}.`,
        });
      }
    }

    let aiReply: string | null = null;
    let aiTags: string[] = [];

    if (process.env.GROQ_API_KEY) {
      try {
        aiTags = (await gerarTagsSemanticas(comment || ''))
          .split(',')
          .map((tag: string): string => tag.trim())
          .filter(Boolean)
          .slice(0, 3);
      } catch (e) {
        console.error('Falha ao gerar tags:', e);
      }
      if (rating <= 3 && comment) {
        try {
          aiReply = await gerarRespostaReview(name, rating, comment, nomeEmpresa, voiceStyle);
        } catch (e) {
          console.error('Falha ao gerar resposta IA:', e);
        }
      }
    }

    await db.run(
      'INSERT INTO reviews (empresa_id, name, rating, comment, ai_reply, ai_tags) VALUES (?, ?, ?, ?, ?, ?)',
      [empresaId, name, rating, comment, aiReply, JSON.stringify(aiTags)]
    );

    res.status(201).json({ success: true, ai_reply: aiReply, ai_tags: aiTags });
  } catch (error) {
    console.error('Erro ao salvar review:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

app.post('/api/auth/login', loginLimiter, async (req: Request, res: Response) => {
  const { cnpj, senha } = req.body;
  if (!cnpj || !senha) return res.status(400).json({ error: 'CNPJ e senha são obrigatórios.' });
  try {
    const cnpjNorm = normalizarCnpj(cnpj);
    const usuario = await db.get('SELECT * FROM usuarios WHERE cnpj = ?', [cnpjNorm]);
    if (!usuario) return res.status(401).json({ error: 'Credenciais inválidas.' });
    const senhaCorreta = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaCorreta) return res.status(401).json({ error: 'Credenciais inválidas.' });
    const token = jwt.sign(
      { id: usuario.id, nome_funcionario: usuario.nome_funcionario, empresa_id: usuario.empresa_id },
      JWT_SECRET,
      { expiresIn: '1d' }
    );
    setAuthCookie(res, token);
    res.json({
      success: true,
      tokenPayload: {
        id: usuario.id,
        nome_funcionario: usuario.nome_funcionario,
        empresa_id: usuario.empresa_id,
      },
    });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

app.post('/api/admin/logout', (_req: Request, res: Response) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

app.get('/api/admin/me', autenticarToken, (req: AuthRequest, res: Response) => {
  res.json({ user: req.user });
});

app.get('/api/admin/empresas', autenticarToken, async (_req: AuthRequest, res: Response) => {
  try {
    const empresas = await db.all(
      'SELECT id, slug, cnpj, nome_empresa, status, google_review_url, criado_em, expira_em FROM empresas ORDER BY criado_em DESC'
    );
    res.json(empresas);
  } catch (error) {
    console.error('Erro ao listar empresas:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

app.get('/api/admin/reviews', autenticarToken, async (_req: AuthRequest, res: Response) => {
  try {
    const reviews = await db.all('SELECT * FROM reviews ORDER BY createdAt DESC LIMIT 100');
    res.json(
      reviews.map((r: any) => ({
        ...r,
        ai_tags: r.ai_tags ? safeParseTags(r.ai_tags) : [],
      }))
    );
  } catch (error) {
    console.error('Erro ao listar reviews:', error);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

app.post('/api/admin/trocar-senha', autenticarToken, async (req: AuthRequest, res: Response) => {
  const { senhaAtual, novaSenha } = req.body;
  if (!senhaAtual || !novaSenha) return res.status(400).json({ error: 'Senha atual e nova senha são obrigatórias.' });
  if (novaSenha.length < 8) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 8 caracteres.' });
  if (!/\d/.test(novaSenha)) return res.status(400).json({ error: 'A nova senha deve conter pelo menos um número.' });

  try {
    const usuario = await db.get('SELECT * FROM usuarios WHERE id = ?', [req.user?.id]);
    if (!usuario) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const senhaCorreta = await bcrypt.compare(senhaAtual, usuario.senha_hash);
    if (!senhaCorreta) return res.status(401).json({ error: 'Senha atual incorreta.' });
    const novoHash = await bcrypt.hash(novaSenha, 10);
    await db.run('UPDATE usuarios SET senha_hash = ? WHERE id = ?', [novoHash, req.user?.id]);
    res.json({ success: true, message: 'Senha alterada com sucesso.' });
  } catch (error) {
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
  } catch (error) {
    console.error('❌ Falha ao iniciar:', error);
    process.exit(1);
  }
}

main();

function montarWhatsAppLink(arg0: string, key: string) {
  const modo = String(arg0 || 'trial').trim();
  const empresaKey = String(key || '').trim();
  const linkAvaliacao = `${APP_URL}/avaliacao/${encodeURIComponent(empresaKey)}`;
  const mensagem =
    modo === 'trial'
      ? `Olá! Gostaria de falar sobre o atendimento da empresa. Link para avaliação: ${linkAvaliacao}`
      : `Olá! Preciso de ajuda com o atendimento da empresa. Link: ${linkAvaliacao}`;
  return `https://wa.me/?text=${encodeURIComponent(mensagem)}`;
}

function fileURLToPath(url: string) {
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

async function callGroq(systemContent: string, userContent: string) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Chave GROQ_API_KEY não configurada no arquivo .env');

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

export async function gerarTagsSemanticas(comentario: string) {
  const systemPrompt =
    'Você é um analista de pós-venda. Extraia até 3 tags semânticas curtas deste feedback (ex: Demora, Comida Fria, Mau Atendimento). Responda apenas com as palavras separadas por vírgula.';
  try {
    return await callGroq(systemPrompt, comentario);
  } catch (error) {
    console.error('Falha ao gerar tags semânticas:', error);
    return 'Geral';
  }
}

async function gerarRelatorioMensalPDF(empresaId: string, mesAno: string): Promise<Buffer> {
  const empresa = await db.get('SELECT * FROM empresas WHERE id = ?', [empresaId]);
  if (!empresa) throw new Error('Empresa não encontrada.');
  if (!['ultra', 'corporate', 'corporativo'].includes(empresa.plan)) {
    throw new Error('Plano não elegível para relatório mensal.');
  }

  const reviews: any[] = await db.all(
    `SELECT rating, comment FROM reviews
     WHERE empresa_id = ?
       AND strftime('%Y-%m', createdAt) = ?`,
    [empresaId, mesAno]
  );

  const criticasRetidas = reviews.filter((r) => r.rating <= 3).length;
  const totalAvaliacoes = reviews.length;
  const notaMedia =
    totalAvaliacoes > 0
      ? reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / totalAvaliacoes
      : 0;

  const BATCH_SIZE = 2000;
  const batches: string[] = [];
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

  const resultados: any[] = [];
  if (batches.length === 0) {
    resultados.push({ sentimento: 'sem dados', gargalos: [] });
  } else {
    for (const batch of batches) {
      const resposta = await callGroq(systemPrompt, batch);
      try {
        resultados.push(JSON.parse(resposta));
      } catch {
        resultados.push({ sentimento: 'indefinido', gargalos: [] });
      }
    }
  }

  const sentimentoContagem: Record<string, number> = {};
  const gargaloContagem: Record<string, number> = {};
  for (const r of resultados) {
    sentimentoContagem[r.sentimento] = (sentimentoContagem[r.sentimento] ?? 0) + 1;
    for (const g of Array.isArray(r.gargalos) ? r.gargalos : []) {
      gargaloContagem[g] = (gargaloContagem[g] ?? 0) + 1;
    }
  }
  const sentimentoPrincipal =
    Object.entries(sentimentoContagem).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'indefinido';
  const topGargalos = Object.entries(gargaloContagem)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([g]) => g);

  const [ano, mes] = mesAno.split('-');
  const nomesMeses = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
  ];
  const periodoFormatado =
    ano && Number(mes) >= 1 && Number(mes) <= 12
      ? `${nomesMeses[Number(mes) - 1]} / ${ano}`
      : mesAno;
  const emissaoFormatada = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(new Date());
  const sentimentoTexto =
    sentimentoPrincipal === 'sem dados'
      ? 'Análise suspensa. Razão: Amostragem insuficiente de dados no período selecionado.'
      : sentimentoPrincipal;
  const gargalosTexto =
    topGargalos.length > 0
      ? topGargalos.join(', ')
      : 'Nenhum ponto de atrito crítico detectado nos canais de atendimento e produto até o momento.';

  const doc = new PDFDocument({
    size: 'A4',
    margin: 42,
    bufferPages: true,
    info: { Title: `${empresa.nome_empresa} - Relatório Mensal ${mesAno}` },
  });
  const chunks: Buffer[] = [];
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
    doc.text('FILTRA.IA', centerX - 180, centerY - 30, { width: 360, align: 'center', lineBreak: false });
    doc.restore();
  };
  drawWatermark();
  doc.on('pageAdded', drawWatermark);

  const sectionTitle = (title: string, subtitle: string) => {
    doc.fillColor(navy).fontSize(13).font('Helvetica-Bold').text(title);
    doc.moveDown(0.2).fillColor(muted).fontSize(8.5).font('Helvetica').text(subtitle);
    doc.moveDown(0.55);
  };
  const drawKpi = (title: string, value: string, description: string, x: number, y: number, width: number) => {
    doc.roundedRect(x, y, width, 86, 6).fillAndStroke(paleGray, line);
    doc.fillColor(blue).fontSize(8).font('Helvetica-Bold').text(title.toUpperCase(), x + 12, y + 12, { width: width - 24 });
    doc.fillColor(navy).fontSize(16).font('Helvetica-Bold').text(value, x + 12, y + 29, { width: width - 24 });
    doc.fillColor(muted).fontSize(8.5).font('Helvetica').text(description, x + 12, y + 57, { width: width - 24, lineGap: 1.5 });
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
  const recommendation =
    'O sistema está operacional e integrado ao seu WhatsApp Business. Divulgue o link ou exiba o QR Code no balcão/mesas para iniciar a coleta automática de feedbacks e alimentar o próximo relatório consolidado.';
  const recY = doc.y;
  doc.roundedRect(42, recY, pageWidth, 76, 6).fillAndStroke(paleBlue, line);
  doc.fillColor(navy).fontSize(9.5).font('Helvetica-Bold').text('Recomendação Estratégica:', 56, recY + 16);
  doc.fillColor(ink).fontSize(9.5).font('Helvetica').text(recommendation, 56, recY + 33, { width: pageWidth - 28, lineGap: 2.5 });

  await new Promise<void>((resolve, reject) => {
    doc.on('end', resolve);
    doc.on('error', reject);
    const range = doc.bufferedPageRange();
    for (let pageIndex = range.start; pageIndex < range.start + range.count; pageIndex += 1) {
      doc.switchToPage(pageIndex);
      doc.fillColor(muted).fontSize(7.5).font('Helvetica').text(
        `© 2026 FILTRA.IA. Propriedade intelectual e dados analíticos protegidos. Uso exclusivo de ${empresa.nome_empresa}.`,
        42,
        doc.page.height - 38,
        { width: pageWidth, align: 'center' }
      );
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
    if (typeof empresaId !== 'string' || typeof mesAno !== 'string') {
      return res.status(400).json({ error: 'empresaId e mesAno são obrigatórios.' });
    }
    const pdf = await gerarRelatorioMensalPDF(empresaId, mesAno);
    res.type('application/pdf').send(pdf);
  } catch (error) {
    console.error('Erro ao gerar relatório:', error);
    if (error instanceof Error && error.message === 'Plano não elegível para relatório mensal.') {
      return res.status(403).json({ error: error.message });
    }
    return res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
  }
});

async function gerarRespostaReview(
  name: string,
  rating: number,
  comment: string,
  nomeEmpresa: string | undefined,
  voiceStyle: string | undefined
): Promise<string> {
  const local = nomeEmpresa ? ` do estabelecimento "${nomeEmpresa}"` : '';
  const estilo = voiceStyle?.trim()
    ? `\nMantenha este estilo de comunicação: ${voiceStyle.slice(0, 1500)}`
    : '';
  const system = `Você responde avaliações negativas de clientes de forma empática, profissional e breve (máximo 3 frases). Peça desculpas quando apropriado e indique que a equipe vai analisar. Não invente políticas ou promessas específicas.${estilo}`;
  const prompt = `Cliente: ${name || 'Anônimo'}\nNota: ${rating}/5\nComentário: ${comment}\n\nEscreva uma resposta curta para esta avaliação negativa${local}.`;
  return callGroq(system, prompt);
}
