/**
 * Cache de PDF em disco - redownload ilimitado sem regenerar e sem tokens de IA.
 * O cache e validado pelo header magico %PDF- antes de ser servido.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const CACHE_VERSION = 'pdf-v3-functional-reports';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function cacheDir(): string {
  const base = process.env.PDF_CACHE_DIR || path.resolve(__dirname, '..', '..', 'data', 'pdf-cache');
  fs.mkdirSync(base, { recursive: true }); return base;
}
function isValidPdf(buf: Buffer): boolean { return Buffer.isBuffer(buf) && buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-'; }
function keyPath(empresaId: string, mesAno: string, plan: string): string {
  const h = crypto.createHash('sha256').update(`${CACHE_VERSION}|${empresaId}|${mesAno}|${plan}`).digest('hex').slice(0, 24);
  return path.join(cacheDir(), `${h}.pdf`);
}
export function readPdfCache(empresaId: string, mesAno: string, plan: string): Buffer | null {
  try { const p = keyPath(empresaId, mesAno, plan); if (!fs.existsSync(p)) return null; const buf = fs.readFileSync(p); if (!isValidPdf(buf)) { try { fs.unlinkSync(p); } catch {} return null; } return buf; } catch { return null; }
}
export function writePdfCache(empresaId: string, mesAno: string, plan: string, buf: Buffer): void {
  try { if (!isValidPdf(buf)) { console.warn('pdfCache: refusing to cache invalid PDF buffer'); return; } fs.writeFileSync(keyPath(empresaId, mesAno, plan), buf); } catch (e) { console.warn('pdfCache write:', (e as Error)?.message || e); }
}
export function invalidatePdfCacheForEmpresa(empresaId: string): number { void empresaId; return 0; }
