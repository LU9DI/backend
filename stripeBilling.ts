/**
 * Stripe Checkout — tabela oficial de planos
 * Inicial | Pro | Ultra | Corporativo | Rei  (mensal e anual)
 *
 * Stripe permanece DESLIGADO por padrão. Para ativar futuramente:
 * STRIPE_ENABLED=true + credenciais Stripe.
 */
import crypto from 'crypto';
import { applyDbPricesToPlanos } from './lib/planPricing.js';

const STRIPE_API = 'https://api.stripe.com/v1';

export type PlanDb = 'inicial' | 'pro' | 'ultra' | 'corporativo' | 'rei';
export type PlanoKey = 'inicial'|'inicial-anual'|'pro'|'pro-anual'|'ultra'|'ultra-anual'|'corporativo'|'corporativo-anual'|'rei'|'rei-anual';
export type PlanoDef = { key: PlanoKey; planDb: PlanDb; label: string; unitAmount: number; interval: 'month'|'year'; displayMonthly: number; reviewLimit: number; envPriceId?: string };

export const PLANOS: Record<string, PlanoDef> = {
  inicial:{key:'inicial',planDb:'inicial',label:'Inicial Mensal',unitAmount:6990,interval:'month',displayMonthly:69.9,reviewLimit:150,envPriceId:process.env.STRIPE_PRICE_INICIAL_MONTHLY},
  'inicial-anual':{key:'inicial-anual',planDb:'inicial',label:'Inicial Anual',unitAmount:4990*12,interval:'year',displayMonthly:49.9,reviewLimit:150,envPriceId:process.env.STRIPE_PRICE_INICIAL_YEARLY},
  pro:{key:'pro',planDb:'pro',label:'Pro Mensal',unitAmount:10990,interval:'month',displayMonthly:109.9,reviewLimit:400,envPriceId:process.env.STRIPE_PRICE_PRO_MONTHLY},
  'pro-anual':{key:'pro-anual',planDb:'pro',label:'Pro Anual',unitAmount:9990*12,interval:'year',displayMonthly:99.9,reviewLimit:400,envPriceId:process.env.STRIPE_PRICE_PRO_YEARLY},
  ultra:{key:'ultra',planDb:'ultra',label:'Ultra Mensal',unitAmount:19990,interval:'month',displayMonthly:199.9,reviewLimit:800,envPriceId:process.env.STRIPE_PRICE_ULTRA_MONTHLY||process.env.STRIPE_PRICE_ULTRA},
  'ultra-anual':{key:'ultra-anual',planDb:'ultra',label:'Ultra Anual',unitAmount:14990*12,interval:'year',displayMonthly:149.9,reviewLimit:800,envPriceId:process.env.STRIPE_PRICE_ULTRA_YEARLY},
  corporativo:{key:'corporativo',planDb:'corporativo',label:'Corporativo Mensal',unitAmount:49990,interval:'month',displayMonthly:499.9,reviewLimit:2500,envPriceId:process.env.STRIPE_PRICE_CORPORATE_MONTHLY||process.env.STRIPE_PRICE_CORPORATE},
  'corporativo-anual':{key:'corporativo-anual',planDb:'corporativo',label:'Corporativo Anual',unitAmount:42990*12,interval:'year',displayMonthly:429.9,reviewLimit:2500,envPriceId:process.env.STRIPE_PRICE_CORPORATE_YEARLY},
  rei:{key:'rei',planDb:'rei',label:'Rei Mensal',unitAmount:99990,interval:'month',displayMonthly:999.9,reviewLimit:8000,envPriceId:process.env.STRIPE_PRICE_REI_MONTHLY},
  'rei-anual':{key:'rei-anual',planDb:'rei',label:'Rei Anual',unitAmount:89990*12,interval:'year',displayMonthly:899.9,reviewLimit:8000,envPriceId:process.env.STRIPE_PRICE_REI_YEARLY},
};
let pricesLoaded=false;
export async function refreshPlanPricesFromDb(db?:any){try{await applyDbPricesToPlanos(PLANOS as any,db);pricesLoaded=true;}catch(e:any){console.warn('[planos] refresh preços:',e?.message||e);}}
export function resolvePlano(raw:string):PlanoDef|null{return PLANOS[String(raw||'').toLowerCase().trim()]||null;}
function stripeEnabled(){return String(process.env.STRIPE_ENABLED||'').toLowerCase()==='true';}
export function stripeConfigured():boolean{return stripeEnabled()&&!!process.env.STRIPE_SECRET_KEY;}
export function stripeWebhookSecret():string{return process.env.STRIPE_WEBHOOK_SECRET||'';}
function appUrl(){return(process.env.APP_URL||process.env.FRONTEND_URL||'http://localhost:3000').replace(/\/$/,'');}
async function stripeForm(path:string,params:Record<string,string>):Promise<any>{if(!stripeConfigured())throw new Error('Stripe está desativado');const key=process.env.STRIPE_SECRET_KEY!;const res=await fetch(`${STRIPE_API}${path}`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params)});const data=await res.json();if(!res.ok)throw new Error(data?.error?.message||`Stripe ${res.status}`);return data;}
export async function criarCheckoutSession(opts:{planoKey:string;empresaId?:string|null;email?:string|null;nomeEmpresa?:string|null}):Promise<{sessionId:string;checkoutUrl:string;label:string;value:number}>{if(!stripeConfigured())throw new Error('Stripe está desativado no Filtra.AI');if(!pricesLoaded)await refreshPlanPricesFromDb();const plano=resolvePlano(opts.planoKey);if(!plano)throw new Error('Plano inválido');const empresaQ=opts.empresaId?`&empresa_id=${encodeURIComponent(opts.empresaId)}`:'';const success=`${appUrl()}/pagamento-ok?checkout=success&session_id={CHECKOUT_SESSION_ID}${empresaQ}&plano=${encodeURIComponent(plano.planDb)}`;const params:Record<string,string>={mode:'subscription',success_url:success,cancel_url:`${appUrl()}/?checkout=cancel`,'metadata[plano]':plano.key,'metadata[plan_db]':plano.planDb,'subscription_data[metadata][plano]':plano.key,'subscription_data[metadata][plan_db]':plano.planDb,allow_promotion_codes:'true','payment_method_types[0]':'card'};if(opts.empresaId){params['metadata[empresa_id]']=opts.empresaId;params.client_reference_id=opts.empresaId;params['subscription_data[metadata][empresa_id]']=opts.empresaId;}if(opts.email)params.customer_email=opts.email;if(opts.nomeEmpresa)params['metadata[nome_empresa]']=String(opts.nomeEmpresa).slice(0,120);if(plano.envPriceId){params['line_items[0][price]']=plano.envPriceId;params['line_items[0][quantity]']='1';}else{params['line_items[0][price_data][currency]']='brl';params['line_items[0][price_data][unit_amount]']=String(plano.unitAmount);params['line_items[0][price_data][recurring][interval]']=plano.interval;params['line_items[0][price_data][product_data][name]'] = `Filtra.IA — ${plano.label}`;params['line_items[0][quantity]']='1';}const session=await stripeForm('/checkout/sessions',params);if(!session.url)throw new Error('Stripe não retornou URL de checkout');return{sessionId:session.id,checkoutUrl:session.url,label:plano.label,value:plano.displayMonthly};}
export async function criarPortalSession(customerId:string):Promise<{url:string}>{if(!stripeConfigured())throw new Error('Stripe está desativado no Filtra.AI');const session=await stripeForm('/billing_portal/sessions',{customer:customerId,return_url:`${appUrl()}/`});if(!session.url)throw new Error('Stripe não retornou URL do portal');return{url:session.url};}
export function constructStripeEvent(rawBody:Buffer|string,signature:string|undefined):any{if(!stripeEnabled())throw new Error('Stripe está desativado');const secret=stripeWebhookSecret();if(!secret)throw new Error('STRIPE_WEBHOOK_SECRET obrigatório');if(!signature)throw new Error('Assinatura Stripe ausente');const elements=signature.split(',').map(p=>p.trim());let timestamp='';const signatures:string[]=[];for(const el of elements){const [k,v]=el.split('=');if(k==='t')timestamp=v;if(k==='v1')signatures.push(v);}if(!timestamp||!signatures.length)throw new Error('Assinatura Stripe inválida');const text=typeof rawBody==='string'?rawBody:rawBody.toString('utf8');const payload=`${timestamp}.${text}`;const expected=crypto.createHmac('sha256',secret).update(payload,'utf8').digest('hex');const ok=signatures.some(sig=>{try{return crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected));}catch{return false;}});if(!ok)throw new Error('Falha na verificação da assinatura Stripe');if(Math.abs(Date.now()/1000-Number(timestamp))>300)throw new Error('Timestamp Stripe expirado');return JSON.parse(text);}
export function extractFromStripeObject(obj:any){const meta=obj?.metadata||{};const empresaId=meta.empresa_id||obj?.client_reference_id||obj?.subscription_details?.metadata?.empresa_id||null;const planDb=meta.plan_db||meta.plano||null;return{empresaId:empresaId?String(empresaId):null,planDb:planDb?String(planDb):null,customerId:obj?.customer?String(obj.customer):null,subscriptionId:obj?.subscription?String(obj.subscription):obj?.id&&String(obj.object)==='subscription'?String(obj.id):null};}
export function listPlanosPublicos(){return Object.keys(PLANOS).map(k=>{const p=PLANOS[k];return{key:p.key,planDb:p.planDb,label:p.label,valueMonthly:p.displayMonthly,interval:p.interval,reviewLimit:p.reviewLimit,priceLabel:p.interval==='month'?`R$ ${p.displayMonthly.toFixed(2).replace('.',',')}`:`R$ ${p.displayMonthly.toFixed(2).replace('.',',')}/mês (anual)`};});}
export {applyDbPricesToPlanos} from './lib/planPricing.js';
