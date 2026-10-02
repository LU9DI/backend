import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { getDb } from '../lib/db.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { verifyInboundSecret, notifyN8n } from '../lib/n8n.js';
import { acquisitionEngineStatus, queueEligibleAcquisition } from '../lib/acquisitionEngine.js';

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 240, message: { error: 'Rate limit acquisition.' } });

function auth(req: Request, res: Response) {
  const secret = String(req.headers['x-filtra-secret'] || req.headers['x-n8n-secret'] || '');
  if (!verifyInboundSecret(secret)) { res.status(401).json({ error: 'Secret n8n inválido ou ausente.' }); return false; }
  return true;
}
const s = (v: unknown, n = 10000) => String(v ?? '').trim().slice(0, n);
const now = () => new Date().toISOString();
const nowIso = () => new Date().toISOString();
const hash = (v: unknown) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const unsubscribeSecret = () => s(process.env.ACQUISITION_UNSUBSCRIBE_SECRET || process.env.JWT_SECRET, 500);
const unsubscribeToken = (leadId: string) => crypto.createHmac('sha256', unsubscribeSecret()).update(leadId).digest('hex');

export async function ensureAcquisitionSchema(db = getDb()) {
  await db.exec(`CREATE TABLE IF NOT EXISTS acquisition_campaigns (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT, status TEXT NOT NULL DEFAULT 'active',
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
  )`);
  await db.exec(`CREATE TABLE IF NOT EXISTS acquisition_content (
    id TEXT PRIMARY KEY, campaign_id TEXT, platform TEXT NOT NULL, title TEXT, body TEXT,
    content_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ, external_post_id TEXT, utm_content TEXT, metadata_json TEXT,
    created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
  )`);
  await db.exec(`CREATE TABLE IF NOT EXISTS acquisition_opportunities (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, title TEXT, url TEXT, description TEXT,
    relevance_score INTEGER, opportunity_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'discovered',
    draft TEXT, approval_required INTEGER NOT NULL DEFAULT 1, published_at TIMESTAMPTZ,
    metadata_json TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
  )`);
  await db.exec(`CREATE TABLE IF NOT EXISTS acquisition_events (
    id TEXT PRIMARY KEY, campaign_id TEXT, content_id TEXT, lead_id TEXT, event_type TEXT NOT NULL,
    source TEXT, medium TEXT, campaign TEXT, content TEXT, occurred_at TIMESTAMPTZ NOT NULL, metadata_json TEXT
  )`);
  await db.exec(`CREATE TABLE IF NOT EXISTS acquisition_daily_metrics (
    id TEXT PRIMARY KEY, metric_date TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'all',
    campaign TEXT NOT NULL DEFAULT 'all', impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0,
    leads INTEGER NOT NULL DEFAULT 0, qualified_leads INTEGER NOT NULL DEFAULT 0, conversions INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, UNIQUE(metric_date, source, campaign)
  )`);
  for (const q of [
    'CREATE INDEX IF NOT EXISTS idx_acq_content_campaign ON acquisition_content(campaign_id)',
    'CREATE INDEX IF NOT EXISTS idx_acq_content_status ON acquisition_content(status)',
    'CREATE INDEX IF NOT EXISTS idx_acq_opp_status ON acquisition_opportunities(status)',
    'CREATE INDEX IF NOT EXISTS idx_acq_events_occurred ON acquisition_events(occurred_at)',
    'CREATE INDEX IF NOT EXISTS idx_acq_events_lead ON acquisition_events(lead_id)',
    'CREATE INDEX IF NOT EXISTS idx_acq_events_campaign ON acquisition_events(campaign_id)'
  ]) { try { await db.exec(q); } catch {} }
}

export function mountAcquisitionRoutes(app: Express) {
  // First-party engagement tracking is intentionally independent of the provider's
  // domain-level tracking flag. It records opens/clicks in acquisition_events.
  app.get('/api/public/acquisition/open', asyncHandler(async (req,res) => {
    const leadId = s(req.query.l, 120);
    if (!leadId) return res.status(400).end();
    const db = getDb(); await ensureAcquisitionSchema(db);
    await db.run(
      `INSERT INTO acquisition_events (id,lead_id,event_type,source,occurred_at,metadata_json)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP,?)
       ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), leadId, 'email.opened', 'first_party_tracking', JSON.stringify({user_agent:req.headers['user-agent'] || null}).slice(0,20000)]
    );
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Length', String(pixel.length));
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.end(pixel);
  }));

  app.get('/api/public/acquisition/click', asyncHandler(async (req,res) => {
    const leadId = s(req.query.l, 120);
    const target = s(req.query.u, 2000);
    if (!leadId || !target) return res.status(400).json({error:'Parâmetros inválidos.'});
    let destination: URL;
    try { destination = new URL(target); } catch { return res.status(400).json({error:'Destino inválido.'}); }
    if (destination.protocol !== 'https:' || destination.hostname !== 'filtraai.com') {
      return res.status(400).json({error:'Destino não autorizado.'});
    }
    const db = getDb(); await ensureAcquisitionSchema(db);
    await db.run(
      `INSERT INTO acquisition_events (id,lead_id,event_type,source,occurred_at,metadata_json)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP,?)
       ON CONFLICT DO NOTHING`,
      [crypto.randomUUID(), leadId, 'email.clicked', 'first_party_tracking', JSON.stringify({target:destination.toString(),user_agent:req.headers['user-agent'] || null}).slice(0,20000)]
    );
    res.redirect(302, destination.toString());
  }));

  app.get('/api/public/acquisition/unsubscribe', limiter, asyncHandler(async (req,res) => {
    const leadId = s(req.query.l, 120);
    const token = s(req.query.t, 200);
    if (!leadId || !token || !unsubscribeSecret()) return res.status(400).send('Link de cancelamento inválido.');
    const expected = unsubscribeToken(leadId);
    if (token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return res.status(400).send('Link de cancelamento inválido.');
    }
    const db = getDb(); await ensureAcquisitionSchema(db);
    const lead = await db.get('SELECT id FROM leads WHERE id=? LIMIT 1', [leadId]);
    if (!lead?.id) return res.status(404).send('Contato não encontrado.');
    await db.run(
      `UPDATE leads SET acquisition_suppressed=1, acquisition_eligible=0,
        acquisition_stage='suppressed', acquisition_next_at=NULL WHERE id=?`,
      [leadId]
    );
    await db.run(
      `INSERT INTO acquisition_events (id,lead_id,event_type,source,occurred_at,metadata_json)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP,?)`,
      [crypto.randomUUID(), leadId, 'email.unsubscribed', 'first_party_unsubscribe',
       JSON.stringify({user_agent:req.headers['user-agent'] || null}).slice(0,20000)]
    );
    res.status(200).send('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Cancelamento confirmado</title><body style="font-family:Arial,sans-serif;padding:40px;max-width:680px;margin:auto"><h1>Cancelamento confirmado</h1><p>Você não receberá novas comunicações de aquisição da Filtra.AI.</p></body></html>');
  }));

  app.get('/api/n8n/acquisition/engine-status', limiter, asyncHandler(async (req,res) => {
    if (!auth(req,res)) return;
    res.json({success:true, engine:await acquisitionEngineStatus()});
  }));

  app.post('/api/n8n/acquisition/engine/tick', limiter, asyncHandler(async (req,res) => {
    if (!auth(req,res)) return;
    const result = await queueEligibleAcquisition(Math.min(25, Math.max(1, Number(req.body?.limit || 25))));
    res.json({success:true, result});
  }));

  app.post('/api/n8n/acquisition/leads/eligibility', limiter, asyncHandler(async (req,res) => {
    if (!auth(req,res)) return;
    const db=getDb(); await ensureAcquisitionSchema(db);
    const leadId=s(req.body?.lead_id,120); const eligible=req.body?.eligible===true;
    if(!leadId) return res.status(400).json({error:'lead_id obrigatório.'});
    const exists=await db.get('SELECT id FROM leads WHERE id=?',[leadId]);
    if(!exists) return res.status(404).json({error:'Lead não encontrado.'});
    const explicitConsent=req.body?.consent===true;
    if (eligible) {
      await db.run(`UPDATE leads
        SET acquisition_eligible=1,
            acquisition_stage=CASE WHEN COALESCE(acquisition_suppressed,0)=1 THEN 'suppressed' ELSE 'ready' END
        WHERE id=?`, [leadId]);
      if (explicitConsent) {
        await db.run(`UPDATE leads SET acquisition_opted_in_at=COALESCE(acquisition_opted_in_at,CURRENT_TIMESTAMP) WHERE id=? AND COALESCE(acquisition_suppressed,0)=0`, [leadId]);
        await db.run(`INSERT INTO acquisition_events (id,lead_id,event_type,source,occurred_at,metadata_json)
          VALUES (?,?,?,?,CURRENT_TIMESTAMP,?)`,
          [crypto.randomUUID(),leadId,'consent','n8n',JSON.stringify({source:'n8n',consent:true,consent_at:nowIso()}).slice(0,20000)]);
      }
    } else {
      await db.run(`UPDATE leads SET acquisition_eligible=0, acquisition_suppressed=1, acquisition_stage='suppressed', acquisition_next_at=NULL WHERE id=?`, [leadId]);
    }
    res.json({success:true,lead_id:leadId,eligible,explicit_consent_recorded:explicitConsent});
  }));

  // Public-channel discoveries are actionable manual prospects. Keep them out of
  // the browser retry loop and expose a small authenticated queue for sales/n8n.
  app.get('/api/n8n/acquisition/manual-queue', limiter, asyncHandler(async (req,res) => {
    if (!auth(req,res)) return;
    const db=getDb();
    const limit=Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    const rows=await db.all(`SELECT id,nome_empresa,email,telefone,whatsapp,fonte,acquisition_source,
        acquisition_stage,browser_channel,browser_channel_data,browser_last_at,browser_last_result,criado_em
      FROM leads
      WHERE acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0
        AND browser_status='channel_found'
      ORDER BY browser_last_at DESC NULLS LAST, criado_em DESC
      LIMIT ?`,[limit]);
    res.json({success:true,count:rows.length,queue:rows});
  }));

  app.post('/api/n8n/acquisition/manual-queue/action', limiter, asyncHandler(async (req,res) => {
    if (!auth(req,res)) return;
    const db=getDb();
    const leadId=s(req.body?.lead_id,120);
    const action=s(req.body?.action,80).toLowerCase();
    const note=s(req.body?.note,2000);
    if(!leadId) return res.status(400).json({error:'lead_id obrigatório.'});
    if(!['contacted','dismissed'].includes(action)) return res.status(400).json({error:'action inválida.'});
    const lead=await db.get('SELECT id,browser_status,acquisition_suppressed FROM leads WHERE id=?',[leadId]);
    if(!lead) return res.status(404).json({error:'Lead não encontrado.'});
    if(action==='contacted'){
      await db.run(`UPDATE leads SET browser_status='contact_attempted',
        browser_last_at=CURRENT_TIMESTAMP,browser_last_result=?,browser_next_at=CURRENT_TIMESTAMP + INTERVAL '30 days',
        acquisition_stage='contacted' WHERE id=?`,[JSON.stringify({manual:true,note}).slice(0,5000),leadId]);
    } else {
      await db.run(`UPDATE leads SET browser_status='failed',
        browser_last_at=CURRENT_TIMESTAMP,browser_last_result=?,browser_next_at=CURRENT_TIMESTAMP + INTERVAL '180 days'
        WHERE id=?`,[JSON.stringify({manual:true,dismissed:true,note}).slice(0,5000),leadId]);
    }
    res.json({success:true,lead_id:leadId,action});
  }));

  app.get('/api/n8n/acquisition/status', limiter, asyncHandler(async (req,res) => {
    if (!auth(req,res)) return; const db=getDb(); await ensureAcquisitionSchema(db);
    const [a,b,c,d]=await Promise.all([
      db.get('SELECT COUNT(*) AS count FROM acquisition_campaigns'),
      db.get('SELECT COUNT(*) AS count FROM acquisition_content'),
      db.get('SELECT COUNT(*) AS count FROM acquisition_opportunities'),
      db.get('SELECT COUNT(*) AS count FROM acquisition_events')
    ]);
    res.json({success:true,persistent:true,tables:{campaigns:Number(a?.count||0),content:Number(b?.count||0),opportunities:Number(c?.count||0),events:Number(d?.count||0)}});
  }));

  app.post('/api/n8n/acquisition/campaigns/upsert', limiter, asyncHandler(async(req,res)=>{
    if(!auth(req,res)) return; const b=req.body||{}, db=getDb(); await ensureAcquisitionSchema(db);
    const id=s(b.id,120)||crypto.randomUUID(), t=now();
    await db.run(`INSERT INTO acquisition_campaigns
      (id,name,platform,status,utm_source,utm_medium,utm_campaign,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,platform=excluded.platform,status=excluded.status,utm_source=excluded.utm_source,
      utm_medium=excluded.utm_medium,utm_campaign=excluded.utm_campaign,updated_at=excluded.updated_at`,
      [id,s(b.name||b.campaign,300)||'Filtra.AI Acquisition',s(b.platform,80)||null,s(b.status,40)||'active',
       s(b.utm_source,120)||null,s(b.utm_medium,120)||null,s(b.utm_campaign,160)||null,t,t]);
    res.json({success:true,persisted:true,id});
  }));

  app.post('/api/n8n/acquisition/content/upsert', limiter, asyncHandler(async(req,res)=>{
    if(!auth(req,res)) return; const b=req.body||{}, db=getDb(); await ensureAcquisitionSchema(db);
    const canonical={platform:s(b.platform,80).toLowerCase(),title:s(b.title,500),body:s(b.body,50000),
      campaign_id:s(b.campaign_id,120),utm_content:s(b.utm_content,160)};
    const ch=s(b.content_hash,128)||hash(canonical), id=s(b.id,120)||crypto.randomUUID(), t=now();
    await db.run(`INSERT INTO acquisition_content
      (id,campaign_id,platform,title,body,content_hash,status,scheduled_at,published_at,external_post_id,utm_content,metadata_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(content_hash) DO UPDATE SET
      campaign_id=excluded.campaign_id,platform=excluded.platform,title=excluded.title,body=excluded.body,
      status=excluded.status,scheduled_at=excluded.scheduled_at,published_at=excluded.published_at,
      external_post_id=COALESCE(excluded.external_post_id,acquisition_content.external_post_id),
      utm_content=excluded.utm_content,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
      [id,canonical.campaign_id||null,canonical.platform||'unknown',canonical.title||null,canonical.body||null,ch,
       s(b.status,40)||'draft',s(b.scheduled_at,80)||null,s(b.published_at,80)||null,s(b.external_post_id,500)||null,
       canonical.utm_content||null,JSON.stringify(b.metadata||{}).slice(0,20000),t,t]);
    const row=await db.get('SELECT id,status,content_hash,external_post_id FROM acquisition_content WHERE content_hash=?',[ch]);
    res.json({success:true,persisted:true,duplicate:row?.id!==id,content:row});
  }));

  app.post('/api/n8n/acquisition/opportunities/upsert', limiter, asyncHandler(async(req,res)=>{
    if(!auth(req,res)) return; const b=req.body||{}, db=getDb(); await ensureAcquisitionSchema(db);
    const canonical={platform:s(b.platform,80).toLowerCase(),url:s(b.url,2000),title:s(b.title,500)};
    const oh=s(b.opportunity_hash,128)||hash(canonical), id=s(b.id,120)||crypto.randomUUID(), t=now();
    await db.run(`INSERT INTO acquisition_opportunities
      (id,platform,title,url,description,relevance_score,opportunity_hash,status,draft,approval_required,published_at,metadata_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(opportunity_hash) DO UPDATE SET
      platform=excluded.platform,title=excluded.title,url=excluded.url,description=excluded.description,
      relevance_score=excluded.relevance_score,status=excluded.status,draft=excluded.draft,
      approval_required=excluded.approval_required,published_at=excluded.published_at,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`,
      [id,canonical.platform||'unknown',canonical.title||null,canonical.url||null,s(b.description,10000)||null,
       Number.isFinite(Number(b.relevance_score))?Number(b.relevance_score):null,oh,s(b.status,40)||'discovered',
       s(b.draft,20000)||null,b.approval_required===false?0:1,s(b.published_at,80)||null,
       JSON.stringify(b.metadata||{}).slice(0,20000),t,t]);
    const row=await db.get('SELECT id,status,opportunity_hash FROM acquisition_opportunities WHERE opportunity_hash=?',[oh]);
    res.json({success:true,persisted:true,opportunity:row});
  }));

  app.post('/api/n8n/acquisition/email-events', limiter, asyncHandler(async(req,res)=>{
    const secret=String(process.env.RESEND_WEBHOOK_SECRET||'').trim();
    const raw=Buffer.isBuffer(req.body)?req.body:Buffer.from(JSON.stringify(req.body??{}));
    const msgId=String(req.headers['svix-id']||'').trim();
    const timestamp=String(req.headers['svix-timestamp']||'').trim();
    const signature=String(req.headers['svix-signature']||'').trim();
    if(!secret||!msgId||!timestamp||!signature) return res.status(401).json({error:'Webhook Resend não configurado ou assinatura ausente.'});
    const ts=Number(timestamp);
    if(!Number.isFinite(ts)||Math.abs(Date.now()/1000-ts)>300) return res.status(401).json({error:'Assinatura Resend expirada.'});
    let key:string|Buffer=secret;
    try { if(secret.startsWith('whsec_')) key=Buffer.from(secret.slice(6),'base64'); } catch { return res.status(401).json({error:'Segredo Resend inválido.'}); }
    const signed=Buffer.from(msgId+'.'+timestamp+'.'+raw.toString('utf8'),'utf8');
    const expected=crypto.createHmac('sha256',key).update(signed).digest('base64');
    const valid=signature.split(' ').some(part=>{ const [v,sig]=part.split(',',2); if(v!=='v1'||!sig)return false; try{return crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected));}catch{return false;} });
    if(!valid) return res.status(401).json({error:'Assinatura Resend inválida.'});
    let payload:any={}; try { payload=JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({error:'Payload JSON inválido.'}); }
    const db=getDb(); await ensureAcquisitionSchema(db);
    const data=payload?.data||{}; const tags=Array.isArray(data?.tags)?data.tags:{};
    const tagMap:any=Array.isArray(tags)?Object.fromEntries(tags.map((t:any)=>[String(t?.name||t?.key||''),String(t?.value||'')])):tags;
    const event=s(payload?.type,80)||'email.unknown';
    const eventId=s(msgId,200)||hash(payload); const occurred=s(payload?.created_at,80)||now();
    const metadata={email_id:data?.email_id||data?.id||null,to:data?.to||null,subject:data?.subject||null,from:data?.from||null,tags:tagMap};
    await db.run(`INSERT INTO acquisition_events
      (id,campaign_id,content_id,lead_id,event_type,source,medium,campaign,content,occurred_at,metadata_json)
      SELECT ?,?,?,?,?,?,?,?,?,?,?
      WHERE NOT EXISTS (SELECT 1 FROM acquisition_events WHERE id=?)`,
      [eventId,s(tagMap.campaign_id,120)||null,s(tagMap.content_id,120)||null,s(tagMap.lead_id||tagMap.leadId,120)||null,
       event,'resend',s(tagMap.utm_medium,120)||null,s(tagMap.utm_campaign,160)||null,s(tagMap.utm_content,160)||null,
       occurred,JSON.stringify(metadata).slice(0,20000),eventId]);

    // Fecha o ciclo de aquisição no próprio backend: o webhook do provedor é
    // a fonte de verdade para entrega, engajamento e supressão.
    const providerEmailId = s(data?.email_id || data?.id, 240);
    if (providerEmailId) {
      const send = await db.get(
        `SELECT id,lead_id FROM acquisition_sends WHERE provider_message_id=? ORDER BY sent_at DESC LIMIT 1`,
        [providerEmailId]
      );
      if (send?.lead_id) {
        const terminal = ['email.bounced','email.complained','email.suppressed'].includes(event);
        const engaged = ['email.opened','email.clicked'].includes(event);
        const delivered = event === 'email.delivered';
        const delayed = event === 'email.delivery_delayed';
        const failed = event === 'email.failed';

        if (terminal) {
          await db.run(
            `UPDATE leads
             SET acquisition_suppressed=1, acquisition_eligible=0,
                 acquisition_stage='suppressed', acquisition_next_at=NULL
             WHERE id=?`,
            [send.lead_id]
          );
        } else if (engaged) {
          await db.run(
            `UPDATE leads
             SET acquisition_stage='engaged', acquisition_next_at=NULL
             WHERE id=? AND COALESCE(acquisition_suppressed,0)=0`,
            [send.lead_id]
          );
        } else if (delivered) {
          await db.run(
            `UPDATE leads
             SET acquisition_stage='delivered'
             WHERE id=? AND COALESCE(acquisition_suppressed,0)=0`,
            [send.lead_id]
          );
        } else if (delayed) {
          await db.run(
            `UPDATE leads
             SET acquisition_stage='delivery_delayed'
             WHERE id=? AND COALESCE(acquisition_suppressed,0)=0`,
            [send.lead_id]
          );
        } else if (failed) {
          await db.run(
            `UPDATE leads SET acquisition_stage='failed'
             WHERE id=? AND COALESCE(acquisition_suppressed,0)=0`,
            [send.lead_id]
          );
        }
      }
    }
    notifyN8n(event, {
      event_id: eventId,
      email_id: data?.email_id||data?.id||null,
      to: data?.to||null,
      subject: data?.subject||null,
      from: data?.from||null,
      tags: tagMap,
      occurred_at: occurred,
      dedupe_key: `resend:${eventId}`
    });
    res.status(200).json({success:true,persisted:true,id:eventId,event_type:event,n8n_queued:true});
  }));

  app.post('/api/public/acquisition/consent', limiter, asyncHandler(async(req,res)=>{
    const db=getDb(); await ensureAcquisitionSchema(db);
    const b=req.body||{};
    const email=s(b.email,320).toLowerCase();
    const company=s(b.company||b.nome_empresa,180);
    const source=s(b.source,120)||'website';
    const consent=b.consent===true;
    if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) return res.status(400).json({error:'E-mail inválido.'});
    if(!consent) return res.status(400).json({error:'Consentimento explícito obrigatório.'});
    let lead=await db.get('SELECT id FROM leads WHERE LOWER(email)=? LIMIT 1',[email]);
    const leadId=String(lead?.id||crypto.randomUUID());
    if(lead?.id){
      await db.run('UPDATE leads SET nome_empresa=COALESCE(NULLIF(? ,\'\'),nome_empresa), acquisition_eligible=1, acquisition_opted_in_at=CURRENT_TIMESTAMP, acquisition_suppressed=0, acquisition_stage=\'ready\', acquisition_source=?, acquisition_next_at=CURRENT_TIMESTAMP WHERE id=?',[company,source,lead.id]);
    } else {
      await db.run('INSERT INTO leads (id,nome_empresa,email,fonte,raw_json,criado_em,acquisition_eligible,acquisition_opted_in_at,acquisition_suppressed,acquisition_stage,acquisition_next_at,acquisition_source) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,1,CURRENT_TIMESTAMP,0,\'ready\',CURRENT_TIMESTAMP,?)',[leadId,company||null,email,source,JSON.stringify({consent:true,consent_source:source,consent_at:new Date().toISOString()}).slice(0,20000),source]);
    }
    await db.run('INSERT INTO acquisition_events (id,lead_id,event_type,source,occurred_at,metadata_json) VALUES (?,?,?,?,CURRENT_TIMESTAMP,?)',[crypto.randomUUID(),leadId,'consent','website',JSON.stringify({source,consent:true,consent_at:new Date().toISOString(),ip:req.ip||null,user_agent:req.headers['user-agent']||null}).slice(0,20000)]);
    res.status(201).json({success:true,persisted:true,lead_id:leadId,stage:'ready'});
  }));

  app.post('/api/n8n/acquisition/events', limiter, asyncHandler(async(req,res)=>{
    if(!auth(req,res)) return; const b=req.body||{}, db=getDb(); await ensureAcquisitionSchema(db);
    const event=s(b.event_type,80); if(!event) return res.status(400).json({error:'event_type obrigatório.'});
    const id=s(b.id,120)||hash({event_type:event,campaign_id:s(b.campaign_id,120),content_id:s(b.content_id,120),
      lead_id:s(b.lead_id,120),occurred_at:s(b.occurred_at,80)||now(),source:s(b.source,120),content:s(b.content,160)});
    await db.run(`INSERT INTO acquisition_events
      (id,campaign_id,content_id,lead_id,event_type,source,medium,campaign,content,occurred_at,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
      [id,s(b.campaign_id,120)||null,s(b.content_id,120)||null,s(b.lead_id,120)||null,event,s(b.source,120)||null,
       s(b.medium,120)||null,s(b.campaign,160)||null,s(b.content,160)||null,s(b.occurred_at,80)||now(),
       JSON.stringify(b.metadata||{}).slice(0,20000)]);
    res.status(201).json({success:true,persisted:true,id});
  }));

  app.get('/api/n8n/acquisition/report', limiter, asyncHandler(async(req,res)=>{
    if(!auth(req,res)) return; const db=getDb(); await ensureAcquisitionSchema(db);
    const from=s(req.query.from,80), to=s(req.query.to,80);
    const [content,opportunities,events,leads]=await Promise.all([
      db.all(`SELECT id,campaign_id,platform,title,status,scheduled_at,published_at,external_post_id,utm_content,created_at
        FROM acquisition_content WHERE (?='' OR created_at>=?) AND (?='' OR created_at<=?) ORDER BY created_at DESC LIMIT 1000`,[from,from,to,to]),
      db.all(`SELECT id,platform,title,url,relevance_score,status,approval_required,created_at,published_at
        FROM acquisition_opportunities WHERE (?='' OR created_at>=?) AND (?='' OR created_at<=?) ORDER BY created_at DESC LIMIT 1000`,[from,from,to,to]),
      db.all(`SELECT id,campaign_id,content_id,lead_id,event_type,source,medium,campaign,content,occurred_at
        FROM acquisition_events WHERE (?='' OR occurred_at>=?) AND (?='' OR occurred_at<=?) ORDER BY occurred_at DESC LIMIT 5000`,[from,from,to,to]),
      db.all(`SELECT id,nome_empresa,email,fonte,score,qualification,criado_em FROM leads
        WHERE (?='' OR criado_em>=?) AND (?='' OR criado_em<=?) ORDER BY criado_em DESC LIMIT 5000`,[from,from,to,to])
    ]);
    const bySource:any={};
    for(const e of events||[]){const k=s(e?.source,120)||'unknown';bySource[k]??={source:k,events:0,leads:0,qualified_leads:0,conversions:0};bySource[k].events++;if(e.event_type==='lead')bySource[k].leads++;if(e.event_type==='qualified')bySource[k].qualified_leads++;if(e.event_type==='conversion')bySource[k].conversions++;}
    res.json({success:true,period:{from:from||null,to:to||null},summary:{
      campaigns:new Set((content||[]).map((x:any)=>x.campaign_id).filter(Boolean)).size,
      content:(content||[]).length,published:(content||[]).filter((x:any)=>x.status==='published').length,
      opportunities:(opportunities||[]).length,events:(events||[]).length,leads:(leads||[]).length,
      qualified_leads:(leads||[]).filter((x:any)=>Number(x.score||0)>=40).length},
      by_source:Object.values(bySource),content,opportunities,recent_events:events,recent_leads:leads});
  }));
}
