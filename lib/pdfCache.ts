/**
 * Cache de PDF em disco — redownload ilimitado sem regenerar e sem tokens de IA.
 * A versão do cache muda quando o layout/regras do relatório mudam, evitando servir PDFs antigos.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const CACHE_VERSION = 'pdf-v4';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function cacheDir(): string {
  const base = process.env.PDF_CACHE_DIR || path.resolve(__dirname, '..', '..', 'data', 'pdf-cache');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function empresaDir(empresaId: string): string {
  const safeId = String(empresaId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(cacheDir(), safeId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isValidPdf(buf: Buffer): boolean {
  return Buffer.isBuffer(buf) && buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-';
}

function keyPath(empresaId: string, mesAno: string, plan: string): string {
  const hash = crypto.createHash('sha256').update(`${CACHE_VERSION}|${empresaId}|${mesAno}|${plan}`).digest('hex').slice(0, 24);
  return path.join(empresaDir(empresaId), `${hash}.pdf`);
}

export function readPdfCache(empresaId: string, mesAno: string, plan: string): Buffer | null {
  try {
    const filePath = keyPath(empresaId, mesAno, plan);
    if (!fs.existsSync(filePath)) return null;
    const buffer = fs.readFileSync(filePath);
    if (!isValidPdf(buffer)) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      return null;
    }
    return buffer;
  } catch {
    return null;
  }
}

export function writePdfCache(empresaId: string, mesAno: string, plan: string, buffer: Buffer): void {
  try {
    if (!isValidPdf(buffer)) {
      console.warn('[pdfCache] recusando cache de PDF inválido');
      return;
    }
    fs.writeFileSync(keyPath(empresaId, mesAno, plan), buffer);
  } catch (error) {
    console.warn('[pdfCache] write:', (error as Error)?.message || error);
  }
}

/** Remove todos os PDFs armazenados para uma empresa. */
export function invalidatePdfCacheForEmpresa(empresaId: string): number {
  let removed = 0;
  try {
    const directory = empresaDir(empresaId);
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.pdf')) continue;
      try {
        fs.unlinkSync(path.join(directory, name));
        removed += 1;
      } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
  return removed;
}
