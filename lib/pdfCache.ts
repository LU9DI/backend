/** Cache de PDF em disco. A chave inclui idioma para nunca servir um relatório traduzido no idioma errado. */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
const CACHE_VERSION='pdf-v5';
const __filename=fileURLToPath(import.meta.url);const __dirname=path.dirname(__filename);
function cacheDir():string{const base=process.env.PDF_CACHE_DIR||path.resolve(__dirname,'..','..','data','pdf-cache');fs.mkdirSync(base,{recursive:true});return base}
function empresaDir(empresaId:string):string{const safe=String(empresaId||'').replace(/[^a-zA-Z0-9_-]/g,'_');const dir=path.join(cacheDir(),safe);fs.mkdirSync(dir,{recursive:true});return dir}
function valid(buf:Buffer){return Buffer.isBuffer(buf)&&buf.length>=5&&buf.subarray(0,5).toString('ascii')==='%PDF-'}
function keyPath(empresaId:string,mesAno:string,plan:string,idioma='pt-BR'){const h=crypto.createHash('sha256').update(`${CACHE_VERSION}|${empresaId}|${mesAno}|${plan}|${idioma}`).digest('hex').slice(0,24);return path.join(empresaDir(empresaId),`${h}.pdf`)}
export function readPdfCache(empresaId:string,mesAno:string,plan:string,idioma='pt-BR'):Buffer|null{try{const p=keyPath(empresaId,mesAno,plan,idioma);if(!fs.existsSync(p))return null;const buf=fs.readFileSync(p);if(!valid(buf)){try{fs.unlinkSync(p)}catch{}return null}return buf}catch{return null}}
export function writePdfCache(empresaId:string,mesAno:string,plan:string,buf:Buffer,idioma='pt-BR'):void{try{if(!valid(buf)){console.warn('[pdfCache] recusando cache de PDF inválido');return}fs.writeFileSync(keyPath(empresaId,mesAno,plan,idioma),buf)}catch(e){console.warn('[pdfCache] write:',(e as Error)?.message||e)}}
export function invalidatePdfCacheForEmpresa(empresaId:string):number{let removed=0;try{const dir=empresaDir(empresaId);for(const name of fs.readdirSync(dir)){if(!name.endsWith('.pdf'))continue;try{fs.unlinkSync(path.join(dir,name));removed++}catch{}}}catch{}return removed}
