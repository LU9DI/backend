/**
 * Montagem isolada de rotas/módulos.
 * Falha de um módulo opcional NÃO derruba o processo.
 */
import type { Express } from 'express';

export type MountResult = { name: string; ok: boolean; error?: string };

const results: MountResult[] = [];

export function getMountResults(): MountResult[] {
  return [...results];
}

export async function safeMount(
  name: string,
  fn: () => void | Promise<void>
): Promise<boolean> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
    return true;
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 240);
    results.push({ name, ok: false, error: msg });
    console.warn(`⚠️  OFF ${name}: ${msg}`);
    return false;
  }
}

/**
 * Import dinâmico + mount. Se o arquivo/export não existir, só desliga o módulo.
 */
export async function safeImportMount(
  name: string,
  importer: () => Promise<Record<string, any>>,
  mountKey: string,
  app: Express,
  ...extraArgs: any[]
): Promise<boolean> {
  return safeMount(name, async () => {
    const mod = await importer();
    const fn = mod[mountKey];
    if (typeof fn !== 'function') {
      throw new Error(`export ${mountKey} ausente`);
    }
    await fn(app, ...extraArgs);
  });
}

export function installProcessGuards(): void {
  process.on('unhandledRejection', (reason: any) => {
    console.error('[unhandledRejection]', reason?.message || reason);
    // NÃO process.exit — evita cascade por promise rejeitada em job/webhook
  });

  process.on('uncaughtException', (err: Error) => {
    console.error('[uncaughtException]', err?.message || err);
    // Erros síncronos graves: loga; só sai se for no boot crítico (quem chama decide)
  });
}
