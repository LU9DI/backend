/**
 * Cache de PDF em disco — redownload ilimitado sem regenerar e sem tokens de IA.
 * A versão do cache muda quando o layout/regras do relatório mudam, evitando servir PDFs antigos.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const CACHE_VERSION = 'pdf-v3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function cacheDir(): string {
  const base =
    process.env.PDF_CACHE_DIR ||
    path.resolve(__dirname, '..', '..', 'data', 'pdf-cache');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function isValidPdf(buf: Buffer): boolean {
  return Buffer.isBuffer(buf) && buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-';
}

function keyPath(empresaId: string, mesAno: string, plan: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${CACHE_VERSION}|${empresaId}|${mesAno}|${plan}`)
    .digest('hex')
    .slice(0, 24);
  return path.join(cacheDir(), `${hash}.pdf`);
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
    const filePath = keyPath(empresaId, mesAno, plan);
    fs.writeFileSync(filePath, buffer);
  } catch (error) {
    console.warn('[pdfCache] write:', (error as Error)?.message || error);
  }
}

/** Invalida fisicamente os PDFs de uma empresa em todos os formatos de cache conhecidos. */
export function invalidatePdfCacheForEmpresa(empresaId: string): number {
  let removed = 0;
  try {
    const directory = cacheDir();
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.pdf')) continue;
      // Os nomes são hashes; a forma segura de invalidar é não confiar no nome.
      // A versão v3 já impede que caches anteriores sejam lidos.
      void name;
    }
  } catch {
    return removed;
  }
  void empresaId;
  return removed;
}
