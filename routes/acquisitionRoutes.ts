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
    const now=eligible?nowIso():null;
    await db.run(`UPDATE leads SET acquisition_eligible=?, acquisition_opted_in_at=?, acquisition_suppressed=?, acquisition_stage=? WHERE id=?`,
      [eligible?1:0,now,eligible?0:1,eligible?'ready':'suppressed',leadId]);
    res.json({success:true,lead_id:leadId,eligible,requires_explicit_opt_in:true});
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
