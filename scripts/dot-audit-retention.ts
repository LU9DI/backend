/**
 * CLI manual de retenção da auditoria do Dot.
 *
 * Uso:
 *   npx tsx scripts/dot-audit-retention.ts
 *   npx tsx scripts/dot-audit-retention.ts --export ./dot-audit-export.json
 *   DOT_AUDIT_RETENTION_CONFIRM=1 npx tsx scripts/dot-audit-retention.ts --purge --yes
 *
 * Sem `--purge` é sempre dry-run. `--purge` exige `--yes` E a variável
 * DOT_AUDIT_RETENTION_CONFIRM=1. Nunca é agendado pela aplicação.
 */
import 'dotenv/config';
import fs from 'node:fs';
import { closeDB, getDb, initDB } from '../lib/db.js';
import { writeAudit } from '../lib/auditLog.js';
import {
  exportExpiredDotAudit,
  planDotAuditRetention,
  purgeExpiredDotAudit,
} from '../services/dotAuditRetention.js';

async function main() {
  const args = process.argv.slice(2);
  const exportIndex = args.indexOf('--export');
  const exportPath = exportIndex >= 0 ? args[exportIndex + 1] : null;
  const purge = args.includes('--purge');
  const yes = args.includes('--yes');

  await initDB();
  try {
    if (purge) {
      if (!yes || process.env.DOT_AUDIT_RETENTION_CONFIRM !== '1') {
        throw new Error(
          'Expurgo exige --yes e DOT_AUDIT_RETENTION_CONFIRM=1. Nada foi apagado.',
        );
      }
      const results = await purgeExpiredDotAudit(getDb(), { confirm: true });
      // Trilha auditável da própria operação de expurgo (não apaga audit_logs).
      await writeAudit(getDb(), {
        action: 'dot.audit_retention_purge',
        actor_user_id: process.env.DOT_AUDIT_RETENTION_ACTOR || 'manual-cli',
        actor_role: 'operator',
        result: 'ok',
        detail: { results },
      });
      console.log(JSON.stringify({ ok: true, mode: 'purge', results }, null, 2));
      return;
    }

    const plan = await planDotAuditRetention(getDb());
    if (exportPath) {
      const data = await exportExpiredDotAudit(getDb());
      fs.writeFileSync(exportPath, JSON.stringify({ exported_at: new Date().toISOString(), plan, data }, null, 2));
      console.log(JSON.stringify({ ok: true, mode: 'export', path: exportPath, plan }, null, 2));
      return;
    }
    console.log(JSON.stringify({ ok: true, mode: 'dry-run', plan }, null, 2));
  } finally {
    await closeDB();
  }
}

main().catch((error) => {
  console.error('[dot-audit-retention] falhou:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
