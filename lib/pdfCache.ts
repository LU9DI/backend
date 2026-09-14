/**
 * Cache de PDF em disco — redownload ilimitado sem regenerar e sem tokens de IA.
 * O versionamento da chave evita servir PDFs gerados por regras antigas.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PDF_CACHE_VERSION = 'v2-integridade-numerica';

function cacheDir(): string {
  const base = process.env.PDF_CACHE_DIR || path.resolve(__dirname, '..', '..', 'data', 'pdf-cache');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function keyPath(empresaId: string, mesAno: string, plan: string): string {
  const h = crypto.createHash('sha256').update(`${PDF_CACHE_VERSION}|${empresaId}|${mesAno}|${plan}`).digest('hex').slice(0, 24);
  return path.join(cacheDir(), `${h}.pdf`);
}

export function readPdfCache(empresaId: string, mesAno: string, plan: string): Buffer | null {
  try {
    const p = keyPath(empresaId, mesAno, plan);
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    return buf.length > 100 ? buf : null;
  } catch {
    return null;
  }
}

export function writePdfCache(empresaId: string, mesAno: string, plan: string, buf: Buffer): void {
  try {
    const p = keyPath(empresaId, mesAno, plan);
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, p);
  } catch (e) {
    console.warn('pdfCache write:', (e as Error)?.message || e);
  }
}

/** Mantido para compatibilidade; caches antigos ficam naturalmente inacessíveis após a mudança de versão. */
export function invalidatePdfCacheForEmpresa(_empresaId: string): number {
  return 0;
}
