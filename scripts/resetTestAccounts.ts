/**
 * Remove empresas de teste, opcionalmente mantendo uma pelo nome.
 *
 *   npx tsx scripts/resetTestAccounts.ts --dry-run --keep "empresa 3"
 *   CONFIRM_RESET=1 npx tsx scripts/resetTestAccounts.ts --keep "empresa 3" --all
 */
import { initDB, getDb } from '../lib/db.js';

const dry = process.argv.includes('--dry-run');
const allMode = process.argv.includes('--all');
const confirmed = process.env.CONFIRM_RESET === '1' || process.argv.includes('--yes');

function argValue(flag: string): string {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.KEEP_EMPRESA || '';
}

function nomeMatch(nome: string, keep: string): boolean {
  const a = String(nome || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const b = String(keep || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

async function main() {
  await initDB();
  const db = getDb();
  const keep = argValue('--keep').trim();

  const all = await db.all(
    `SELECT id, nome_empresa, cnpj, slug, plan, status, criado_em FROM empresas ORDER BY criado_em DESC`
  );

  console.log(`Total no banco: ${all?.length || 0}`);
  for (const e of all || []) {
    const keepFlag =
      keep && (nomeMatch(e.nome_empresa, keep) || nomeMatch(e.slug || '', keep))
        ? ' [MANTER]'
        : '';
    console.log(` - ${e.nome_empresa} | ${e.plan}/${e.status} | ${e.slug || e.id}${keepFlag}`);
  }

  let targets = all || [];
  if (allMode) {
    if (!keep) {
      console.error('Com --all é obrigatório --keep "nome".');
      process.exit(1);
    }
    targets = targets.filter(
      (e: any) => !nomeMatch(e.nome_empresa, keep) && !nomeMatch(e.slug || '', keep)
    );
  } else {
    targets = targets.filter(
      (e: any) =>
        ['trial', 'teste', 'test'].includes(String(e.plan || '').toLowerCase()) ||
        ['trial', 'teste', 'test'].includes(String(e.status || '').toLowerCase())
    );
    if (keep) {
      targets = targets.filter(
        (e: any) => !nomeMatch(e.nome_empresa, keep) && !nomeMatch(e.slug || '', keep)
      );
    }
  }

  console.log(`\nA remover: ${targets.length}`);
  for (const e of targets) console.log(`  x ${e.nome_empresa}`);

  if (keep) {
    const kept = (all || []).filter(
      (e: any) => nomeMatch(e.nome_empresa, keep) || nomeMatch(e.slug || '', keep)
    );
    console.log(`A manter (--keep "${keep}"): ${kept.length}`);
    if (!kept.length) {
      console.error('Nenhuma empresa bate com --keep. Abortando.');
      process.exit(1);
    }
  }

  if (!targets.length) {
    console.log('Nada a limpar.');
    process.exit(0);
  }

  if (dry) {
    console.log('[dry-run] Nenhuma exclusão feita.');
    process.exit(0);
  }

  if (!confirmed) {
    console.error(
      'Para executar: CONFIRM_RESET=1 npx tsx scripts/resetTestAccounts.ts --keep "empresa 3" --all'
    );
    process.exit(1);
  }

  let reviews = 0;
  let users = 0;
  for (const e of targets) {
    const id = e.id;
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

  console.log(`OK. Removidas ${targets.length} | reviews~${reviews} | usuarios~${users}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
