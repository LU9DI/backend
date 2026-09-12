/** Self-contained Filtra.AI PDF runtime generator. */
import type { Database } from 'sqlite';
import PDFDocument from 'pdfkit';
import { empresaTemPdf, isTrialPlan } from './lib/plans.js';

type Lang='pt-BR'|'en-US'|'es-ES'|'fr-FR'|'de-DE'|'it-IT'|'zh-CN';
type Review={rating:number;createdAt?:string|Date;created_at?:string|Date;createdat?:string|Date;is_test?:number|boolean|null};
const LANGS:Lang[]=['pt-BR','en-US','es-ES','fr-FR','de-DE','it-IT','zh-CN'];
const T:Record<Lang,Record<string,string>>={
'pt-BR':{title:'Relatório mensal de reputação',period:'Período',plan:'Plano',summary:'Resumo executivo',reviews:'Avaliações válidas',avg:'Nota média',positive:'Positivas',critical:'Críticas',distribution:'Distribuição de notas',empty:'Nenhuma avaliação válida foi registrada no período.',page:'Página'},
'en-US':{title:'Monthly reputation report',period:'Period',plan:'Plan',summary:'Executive summary',reviews:'Valid reviews',avg:'Average rating',positive:'Positive',critical:'Critical',distribution:'Rating distribution',empty:'No valid reviews were recorded for this period.',page:'Page'},
'es-ES':{title:'Informe mensual de reputación',period:'Período',plan:'Plan',summary:'Resumen ejecutivo',reviews:'Reseñas válidas',avg:'Calificación media',positive:'Positivas',critical:'Críticas',distribution:'Distribución de calificaciones',empty:'No se registraron reseñas válidas en este período.',page:'Página'},
'fr-FR':{title:'Rapport mensuel de réputation',period:'Période',plan:'Plan',summary:'Résumé exécutif',reviews:'Avis valides',avg:'Note moyenne',positive:'Positifs',critical:'Critiques',distribution:'Répartition des notes',empty:'Aucun avis valide n’a été enregistré sur cette période.',page:'Page'},
'de-DE':{title:'Monatlicher Reputationsbericht',period:'Zeitraum',plan:'Plan',summary:'Zusammenfassung',reviews:'Gültige Bewertungen',avg:'Durchschnittliche Bewertung',positive:'Positiv',critical:'Kritisch',distribution:'Bewertungsverteilung',empty:'Für diesen Zeitraum wurden keine gültigen Bewertungen erfasst.',page:'Seite'},
'it-IT':{title:'Report mensile sulla reputazione',period:'Periodo',plan:'Piano',summary:'Riepilogo',reviews:'Recensioni valide',avg:'Valutazione media',positive:'Positive',critical:'Critiche',distribution:'Distribuzione delle valutazioni',empty:'Nessuna recensione valida registrata nel periodo.',page:'Pagina'},
'zh-CN':{title:'每月声誉报告',period:'期间',plan:'方案',summary:'执行摘要',reviews:'有效评价',avg:'平均评分',positive:'正面',critical:'负面',distribution:'评分分布',empty:'该期间没有有效评价记录。',page:'页'}
};
function langOf(v?:string|null):Lang{const s=String(v||'pt-BR').trim();return LANGS.includes(s as Lang)?s as Lang:'pt-BR';}
function tx(l:Lang,k:string){return T[l][k]||T['en-US'][k]||k;}
function isTest(r:Review){return Number(r.is_test)===1||r.is_test===true;}
function inMonth(r:Review,m:string){const d=r.createdAt??r.created_at??r.createdat;if(!d)return true;const s=typeof d==='string'?d:new Date(d).toISOString();return s.slice(0,7)===m;}
async function loadReviews(db:Database,id:string,m:string){const qs=['SELECT * FROM reviews WHERE empresa_id=?','SELECT rating,is_test,created_at FROM reviews WHERE empresa_id=?'];for(const q of qs){try{const rows=await db.all(q,[id]) as Review[];return (rows||[]).filter(r=>!isTest(r)&&inMonth(r,m));}catch{}}return[];}
export async function ensureUnidadesSchema(_db:Database):Promise<void>{return;}
export async function gerarRelatorioMensalPDF(db:Database,empresaId:string,mesAno:string,_callGroq?:Function,idioma:string='pt-BR'):Promise<Buffer>{
 const empresa:any=await db.get('SELECT * FROM empresas WHERE id=?',[empresaId]);
 if(!empresa)throw new Error('Empresa não encontrada.');
 const plan=String(empresa.plan||empresa.status||'').trim().toLowerCase();
 const trial=isTrialPlan(plan)||isTrialPlan(String(empresa.status||''));
 if(!empresaTemPdf(empresa)&&!trial)throw new Error('Plano não elegível para relatório mensal.');
 const lang=langOf(idioma||empresa.locale||empresa.idioma||empresa.language);
 const rs=await loadReviews(db,empresaId,mesAno);const total=rs.length;
 const avg=total?rs.reduce((s,r)=>s+Number(r.rating||0),0)/total:0;
 const pos=rs.filter(r=>Number(r.rating)>=4).length,crit=rs.filter(r=>Number(r.rating)<=3).length;
 const dist=[1,2,3,4,5].map(n=>rs.filter(r=>Number(r.rating)===n).length);
 const doc=new PDFDocument({size:'A4',margin:48,bufferPages:true,compress:true});const chunks:Buffer[]=[];doc.on('data',(c:Buffer)=>chunks.push(c));
 doc.rect(0,0,doc.page.width,82).fill('#0f172a');doc.fillColor('#fff').font('Helvetica-Bold').fontSize(18).text('Filtra.AI',48,20);doc.font('Helvetica').fontSize(9).fillColor('#cbd5e1').text(tx(lang,'title'),48,47);
 doc.y=108;doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(18).text(String(empresa.nome_empresa||'Empresa'));doc.moveDown(.25);doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(`${tx(lang,'period')}: ${mesAno}   |   ${tx(lang,'plan')}: ${trial?'Trial':plan.toUpperCase()}`);doc.moveDown(1);
 doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(13).text(tx(lang,'summary'));doc.moveDown(.6);
 const labels=[[tx(lang,'reviews'),String(total)],[tx(lang,'avg'),avg?avg.toFixed(2):'-'],[tx(lang,'positive'),String(pos)],[tx(lang,'critical'),String(crit)]];const gap=8,w=(doc.page.width-96-gap*3)/4,y=doc.y;
 labels.forEach((it,i)=>{const x=48+i*(w+gap);doc.roundedRect(x,y,w,68,6).fillAndStroke('#f8fafc','#e2e8f0');doc.fillColor('#64748b').font('Helvetica-Bold').fontSize(7).text(it[0],x+10,y+11,{width:w-20});doc.fillColor('#0f172a').fontSize(18).text(it[1],x+10,y+30,{width:w-20});});doc.y=y+88;
 doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(13).text(tx(lang,'distribution'));doc.moveDown(.5);const max=Math.max(...dist,1),cw=doc.page.width-96,bw=70,bgap=(cw-bw*5)/4,base=doc.y+130;dist.forEach((v,i)=>{const h=Math.max(2,v/max*105),x=48+i*(bw+bgap);doc.roundedRect(x,base-h,bw,h,4).fill(['#ef4444','#f97316','#eab308','#84cc16','#22c55e'][i]);doc.fillColor('#334155').font('Helvetica').fontSize(8).text(`${i+1}: ${v}`,x,base+8,{width:bw,align:'center'});});doc.y=base+35;
 if(!total){doc.fillColor('#64748b').font('Helvetica').fontSize(9).text(tx(lang,'empty'));}
 const range=doc.bufferedPageRange();for(let i=0;i<range.count;i++){doc.switchToPage(range.start+i);doc.fillColor('#94a3b8').font('Helvetica').fontSize(7).text(`${tx(lang,'page')} ${i+1}/${range.count}`,48,doc.page.height-32,{width:doc.page.width-96,align:'center',lineBreak:false});}
 const done=new Promise<void>((resolve,reject)=>{doc.once('end',resolve);doc.once('error',reject)});doc.end();await done;const out=Buffer.concat(chunks);if(out.subarray(0,5).toString('ascii')!=='%PDF-')throw new Error('PDF gerado inválido.');return out;
}
