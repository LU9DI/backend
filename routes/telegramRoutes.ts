/**
 * Telegram Bot — vínculo de chat e envio de follow-up.
 */
import crypto from 'crypto';
import type { Express, Request, Response } from 'express';
import { getDb } from '../lib/db.js';

const TELEGRAM_API = 'https://api.telegram.org';

function botToken(): string {
  return String(process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || '').trim();
}
function webhookSecret(): string {
  return String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
}
function authWebhook(req: Request, res: Response): boolean {
  const expected = webhookSecret();
  const received = String(req.headers['x-telegram-bot-api-secret-token'] || '').trim();
  if (!expected || !received) {
    res.status(401).json({ error: 'Webhook Telegram não configurado.' });
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Secret do webhook Telegram inválido.' });
    return false;
  }
  return true;
}
async function ensureTelegramColumns() {
  const db = getDb();
  await db.exec('CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, nome_empresa TEXT, email TEXT, telefone TEXT, fonte TEXT, maps_url TEXT, raw_json TEXT, criado_em TIMESTAMPTZ NOT NULL)');
  try { await db.exec('ALTER TABLE leads ADD COLUMN telegram_chat_id TEXT'); } catch {}
  try { await db.exec('CREATE INDEX IF NOT EXISTS idx_leads_telegram_chat_id ON leads(telegram_chat_id)'); } catch {}
}
async function telegramApi(method: string, body: Record<string, unknown>) {
  const token = botToken();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN não configurado');
  const response = await fetch(TELEGRAM_API + '/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await response.text().catch(() => '');
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  if (!response.ok || data.ok === false) {
    throw new Error('Telegram API HTTP ' + response.status + ': ' + String(data?.description || raw).slice(0, 300));
  }
  return data;
}
export function mountTelegramRoutes(app: Express) {
  app.get('/api/telegram/status', async (_req, res) => {
    const configured = Boolean(botToken());
    const webhookConfigured = Boolean(webhookSecret());
    let bot: any = null;
    if (configured) {
      try {
        const data = await telegramApi('getMe', {});
        bot = { id: data?.result?.id || null, username: data?.result?.username || null, first_name: data?.result?.first_name || null };
      } catch (e: any) {
        return res.status(503).json({
          configured: true, webhook_secret_configured: webhookConfigured, bot_api_ok: false,
          error: String(e?.message || e).slice(0, 300),
        });
      }
    }
    res.json({
      configured, webhook_secret_configured: webhookConfigured, bot_api_ok: configured, bot,
      webhook_path: 'POST /api/telegram/webhook', start_command: '/start <lead_id>',
    });
  });

  app.post('/api/telegram/webhook', async (req: Request, res: Response) => {
    if (!authWebhook(req, res)) return;
    await ensureTelegramColumns();
    const update = req.body || {};
    const message = update.message || update.edited_message || update.channel_post || null;
    const chatId = message?.chat?.id;
    if (chatId === undefined || chatId === null) return res.json({ ok: true, ignored: true, reason: 'sem chat' });

    const text = String(message?.text || '').trim();
    const match = text.match(/^\/start(?:\s+(.+))?$/i);
    if (!match) {
      await telegramApi('sendMessage', { chat_id: chatId, text: 'Olá! Para vincular este Telegram ao seu cadastro, use o link de conexão enviado pelo Filtra.AI.' }).catch(() => {});
      return res.json({ ok: true, linked: false });
    }

    const leadId = String(match[1] || '').trim();
    if (!leadId) {
      await telegramApi('sendMessage', { chat_id: chatId, text: 'Para vincular, use /start seguido do código de conexão do Filtra.AI.' }).catch(() => {});
      return res.json({ ok: true, linked: false, reason: 'lead_id ausente' });
    }

    const db = getDb();
    const lead = await db.get('SELECT id, nome_empresa FROM leads WHERE id = ?', [leadId]);
    if (!lead) {
      await telegramApi('sendMessage', { chat_id: chatId, text: 'Não encontrei esse código de conexão. Gere um novo link no Filtra.AI.' }).catch(() => {});
      return res.status(404).json({ ok: false, error: 'Lead não encontrado.', lead_id: leadId });
    }

    await db.run('UPDATE leads SET telegram_chat_id = ? WHERE id = ?', [String(chatId), leadId]);
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: 'Telegram conectado ao cadastro da ' + String(lead.nome_empresa || 'empresa') + ' no Filtra.AI. Você poderá receber os acompanhamentos por aqui.',
    }).catch(() => {});

    return res.json({ ok: true, linked: true, lead_id: leadId, telegram_chat_id: String(chatId) });
  });
}
