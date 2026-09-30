import crypto from 'crypto';
import { getDb } from './db.js';
import { ensureAcquisitionEngineSchema } from './acquisitionEngine.js';

const MIN_STOCK = Math.max(80, Number(process.env.ACQUISITION_MIN_STOCK || 160));
const BATCH_SIZE = Math.min(500, Math.max(1, Number(process.env.ACQUISITION_REPLENISH_BATCH || 200)));
const INTERVAL_MS = Math.max(60000, Number(process.env.ACQUISITION_REPLENISH_INTERVAL_MS || 600000));
let running = false;
let started = false;

const clean = (v: unknown, n=5000) => String(v ?? '').trim().slice(0,n);
const validEmail = (v: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(v,320));
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

async function providerRequest() {
  const url = clean(process.env.ACQUISITION_REPLENISH_URL,2000);
  if (!url) return { ok:false, reason:'provider_not_configured', leads:[] };
  const headers: Record<string,string> = {'content-type':'application/json'};
  const token = clean(process.env.ACQUISITION_REPLENISH_TOKEN,1000);
  if (token) headers.authorization = 'Bearer '+token;
  const response = await fetch(url,{method:'POST',headers,body:JSON.stringify({
    limit:BATCH_SIZE,min_stock:MIN_STOCK,exclude_existing:true,require_professional_email:true,source:'filtra_acquisition_engine'
  })});
  const raw = await response.text();
  let data:any={}; try { data=JSON.parse(raw); } catch {}
  if (!response.ok) throw new Error('replenishment provider HTTP '+response.status);
  return {ok:true,reason:'ok',leads:Array.isArray(data?.leads)?data.leads:(Array.isArray(data)?data:[])};
}

export async function replenishAcquisitionStock(force=false) {
  if (running) return {imported:0,skipped:0,reason:'already_running'};
  running=true;
  try {
    const db=getDb(); await ensureAcquisitionEngineSchema(db);
    const row=await db.get(`SELECT COUNT(*) AS c FROM leads
      WHERE acquisition_eligible=1 AND COALESCE(acquisition_suppressed,0)=0
      AND email IS NOT NULL AND TRIM(email)!=''
      AND acquisition_stage IN ('eligible','ready','followup')
      AND (acquisition_next_at IS NULL OR acquisition_next_at<=CURRENT_TIMESTAMP)`);
    const stock=Number(row?.c||0);
    if(!force && stock>=MIN_STOCK) return {imported:0,skipped:0,reason:'stock_ok',stock,min_stock:MIN_STOCK};
    const result=await providerRequest();
    if(!result.ok) return {imported:0,skipped:0,reason:result.reason,stock,min_stock:MIN_STOCK};
    let imported=0, skipped=0;
    for(const lead of result.leads){
      const email=clean(lead?.email,320).toLowerCase();
      if(!validEmail(email)){skipped++;continue;}
      const exists=await db.get('SELECT id FROM leads WHERE LOWER(email)=? LIMIT 1',[email]);
      if(exists){skipped++;continue;}
      const id=clean(lead?.id,180)||'provider-'+hash(email).slice(0,32);
      try{
        await db.run(`INSERT INTO leads
          (id,nome_empresa,email,fonte,raw_json,criado_em,acquisition_eligible,acquisition_suppressed,acquisition_stage,acquisition_next_at,acquisition_source,acquisition_timezone)
          VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,1,0,'eligible',CURRENT_TIMESTAMP,?,?)`,
          [id,clean(lead?.company||lead?.nome_empresa,180)||null,''+email,clean(lead?.source,120)||'acquisition_provider',JSON.stringify(lead).slice(0,20000),clean(lead?.source,120)||'acquisition_provider',clean(lead?.timezone,120)||null]);
        imported++;
      }catch(e:any){ if(/duplicate|unique|constraint/i.test(String(e?.message||e))) skipped++; else throw e; }
    }
    return {imported,skipped,provider_returned:result.leads.length,stock,min_stock:MIN_STOCK};
  } finally { running=false; }
}

export function startAcquisitionReplenisher(){
  if(started||process.env.ACQUISITION_REPLENISHER!=='1') return;
  started=true;
  const tick=()=>replenishAcquisitionStock().then(r=>console.log('[acquisition-replenisher]',r)).catch(e=>console.warn('[acquisition-replenisher]',e?.message||e));
  tick(); setInterval(tick,INTERVAL_MS);
}
