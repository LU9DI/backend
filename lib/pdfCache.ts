/**
 * Cache de PDF: memória (quente) + disco (frio).
 * Redownload sem regenerar e sem tokens de IA.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MEM_MAX = Math.max(8, Number(process.env.PDF_CACHE_MEM_MAX || 32));
const MEM_TTL_MS = Math.max(60_000, Number(process.env.PDF_CACHE_TTL_MS || 6 * 60 * 60 * 1000)); // 6h

type MemEntry = { buf: Buffer; at: number };
const mem = new Map<string, MemEntry>();

/** Gerações em voo — evita 2 PDFs iguais ao mesmo tempo. */
const inflight = new Map<string, Promise<Buffer>>();

function cacheDir(): string {
  const base =
    process.env.PDF_CACHE_DIR ||
    path.resolve(__dirname, '..', '..', 'data', 'pdf-cache');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function cacheKey(empresaId: string, mesAno: string, plan: string, fingerprint = ''): string {
  return crypto
    .createHash('sha256')
    .update(`${empresaId}|${mesAno}|${plan}|${fingerprint}`)
    .digest('hex')
    .slice(0, 28);
}

function keyPath(key: string): string {
  return path.join(cacheDir(), `${key}.pdf`);
}

function memGet(key: string): Buffer | null {
  const e = mem.get(key);
  if (!e) return null;
  if (Date.now() - e.at > MEM_TTL_MS) {
    mem.delete(key);
    return null;
  }
  // LRU touch
  mem.delete(key);
  mem.set(key, { buf: e.buf, at: Date.now() });
  return e.buf;
}

function memSet(key: string, buf: Buffer): void {
  if (mem.size >= MEM_MAX) {
    const first = mem.keys().next().value;
    if (first) mem.delete(first);
  }
  mem.set(key, { buf, at: Date.now() });
}

export function readPdfCache(
  empresaId: string,
  mesAno: string,
  plan: string,
  fingerprint = ''
): Buffer | null {
  const key = cacheKey(empresaId, mesAno, plan, fingerprint);
  const hit = memGet(key);
  if (hit) return hit;
  try {
    const p = keyPath(key);
    if (!fs.existsSync(p)) return null;
    const buf = fs.readFileSync(p);
    if (buf?.length) memSet(key, buf);
    return buf;
  } catch {
    return null;
  }
}

export function writePdfCache(
  empresaId: string,
  mesAno: string,
  plan: string,
  buf: Buffer,
  fingerprint = ''
): void {
  const key = cacheKey(empresaId, mesAno, plan, fingerprint);
  memSet(key, buf);
  // disco em background — não atrasa a resposta HTTP
  setImmediate(() => {
    try {
      fs.writeFileSync(keyPath(key), buf);
    } catch (e) {
      console.warn('pdfCache write:', (e as Error)?.message || e);
    }
  });
}

/** Dedup de geração concorrente do mesmo relatório. */
export async function withPdfInflight(
  empresaId: string,
  mesAno: string,
  plan: string,
  fingerprint: string,
  factory: () => Promise<Buffer>
): Promise<Buffer> {
  const key = cacheKey(empresaId, mesAno, plan, fingerprint);
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = factory().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

export function invalidatePdfCacheForEmpresa(_empresaId: string): number {
  // hashes opacos — limpa memória; disco sobrescrito na próxima geração
  const n = mem.size;
  mem.clear();
  return n;
}
