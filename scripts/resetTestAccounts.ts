/**
 * Reset de contas de teste (trial/teste).
 * Uso (no servidor com DATABASE_URL ou SQLite):
 *   npx tsx scripts/resetTestAccounts.ts --dry-run
 *   CONFIRM_RESET=1 npx tsx scripts/resetTestAccounts.ts
 */
import { initDB, getDb } from '../lib/db.js';

const dry = process.argv.includes('--dry-run');
const confirmed = process.env.CONFIRM_RESET === '1' || process.argv.includes('--yes');

async function main() {
  await initDB();
  const db = getDb();

  const rows = await db.all(
    `SELECT id, nome_empresa, cnpj, slug, plan, status, criado_em
     FROM empresas
     WHERE LOWER(COALESCE(plan,'')) IN ('trial','teste','test')
        OR LOWER(COALESCE(status,'')) IN ('trial','teste','test')
     ORDER BY criado_em DESC`
  );

  console.log(`Encontradas ${rows?.length || 0} conta(s) de teste/trial.`);
  for (const e of rows || []) {
    console.log(` - ${e.nome_empresa} | ${e.plan}/${e.status} | ${e.cnpj || e.slug || e.id}`);
  }

  if (!rows?.length) {
    console.log('Nada a limpar.');
    process.exit(0);
  }

  if (dry) {
    console.log('[dry-run] Nenhuma exclusão feita.');
    process.exit(0);
  }

  if (!confirmed) {
    console.error('Para executar: CONFIRM_RESET=1 npx tsx scripts/resetTestAccounts.ts');
    process.exit(1);
  }

  const ids = rows.map((r: any) => r.id);
  let reviews = 0;
  let users = 0;

  for (const id of ids) {
    try {
      const r = await db.run(`DELETE FROM reviews WHERE empresa_id = ?`, [id]);
      reviews += Number((r as any)?.changes || 0);
    } catch { /* */ }
    try {
      const r = await db.run(
        `DELETE FROM usuarios WHERE empresa_id = ? AND COALESCE(empresa_id,'') != 'admin'`,
        [id]
      );
      users += Number((r as any)?.changes || 0);
    } catch { /* */ }
    try {
      await db.run(`DELETE FROM ai_usage WHERE empresa_id = ?`, [id]);
    } catch { /* */ }
    for (const q of [
      `DELETE FROM push_subscriptions WHERE empresa_id = ?`,
      `DELETE FROM unidades WHERE empresa_id = ?`,
      `DELETE FROM webauthn_credentials WHERE empresa_id = ?`,
    ]) {
      try {
        await db.run(q, [id]);
      } catch { /* */ }
    }
    await db.run(`DELETE FROM empresas WHERE id = ?`, [id]);
  }

  console.log(`OK. Removidas ${ids.length} empresas | reviews~${reviews} | usuarios~${users}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
