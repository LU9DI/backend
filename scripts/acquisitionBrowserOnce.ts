import 'dotenv/config';

console.log('[acquisition-browser] isolated entry pid=' + process.pid + ' child=' + String(process.env.ACQUISITION_BROWSER_CHILD || ''));

async function main() {
  const { runAcquisitionBrowserBotTick } = await import('../lib/acquisitionBrowserBot.ts');
  console.log('[acquisition-browser] isolated browser module imported');
  await runAcquisitionBrowserBotTick(true);
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
