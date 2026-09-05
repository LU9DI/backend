/**
 * CLI: preenche sentimento em reviews antigas.
 *
 *   npx tsx scripts/backfillSentiment.ts
 *   npx tsx scripts/backfillSentiment.ts --force
 *   npx tsx scripts/backfillSentiment.ts --ai --limit=500
 *   npx tsx scripts/backfillSentiment.ts --empresa=UUID
 */
import 'dotenv/config';
import { initDB, getDb } from '../lib/db.js';
import {
  backfillSentiment,
  countMissingSentiment,
} from '../services/sentimentBackfill.js';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  await initDB();
  const db = getDb();

  const missingBefore = await countMissingSentiment(db);
  console.log(`📊 Reviews sem sentimento: ${missingBefore}`);

  const limit = Number(arg('limit') || 5000);
  const useAi = hasFlag('ai');
  const force = hasFlag('force');
  const empresaId = arg('empresa');

  if (useAi) {
    console.log('⚠️  Modo IA ativo — mais lento e consome tokens.');
  }

  const result = await backfillSentiment(db, {
    limit,
    useAi,
    force,
    empresaId,
  });

  const missingAfter = await countMissingSentiment(db);

  console.log('────────────────────────────────────');
  console.log(`Escaneadas:  ${result.scanned}`);
  console.log(`Atualizadas: ${result.updated}`);
  console.log(`Puladas:     ${result.skipped}`);
  console.log(`Erros:       ${result.errors}`);
  console.log(`Tempo:       ${result.duration_ms}ms`);
  console.log(`Ainda sem:   ${missingAfter}`);
  console.log('────────────────────────────────────');

  if (missingAfter > 0 && result.updated > 0) {
    console.log('ℹ️  Ainda há pendentes — rode de novo para o próximo lote.');
  } else if (missingAfter === 0) {
    console.log('✅ Todas as reviews têm sentimento.');
  }

  process.exit(result.errors > 0 && result.updated === 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
