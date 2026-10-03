import 'dotenv/config';

console.log('[acquisition-browser] isolated entry pid=' + process.pid + ' child=' + String(process.env.ACQUISITION_BROWSER_CHILD || ''));

async function main() {
  console.log('[acquisition-browser] isolated importing browser module');
  const mod = await Promise.race([
    import('../lib/acquisitionBrowserBot.ts'),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('isolated_worker_import_timeout_15s')), 15_000)
    ),
  ]);
  console.log('[acquisition-browser] isolated browser module imported');
  await mod.runAcquisitionBrowserBotTick(true);
}

main()
  .then(() => {
    console.log('[acquisition-browser] isolated entry complete pid=' + process.pid);
    setTimeout(() => process.exit(0), 50);
  })
  .catch((error) => {
    console.error('[acquisition-browser] isolated worker fatal:', error?.message || error);
    process.exit(1);
  });
