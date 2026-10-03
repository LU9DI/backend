import 'dotenv/config';

console.log('[acquisition-browser] isolated entry pid=' + process.pid + ' child=' + String(process.env.ACQUISITION_BROWSER_CHILD || ''));

async function timedImport(label: string, loader: () => Promise<any>) {
  console.log('[acquisition-browser] import start ' + label);
  const result = await Promise.race([
    loader(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('isolated_import_timeout_' + label)), 10_000)
    ),
  ]);
  console.log('[acquisition-browser] import done ' + label);
  return result;
}

async function main() {
  await timedImport('puppeteer', () => import('puppeteer-core'));
  await timedImport('db', () => import('../lib/db.ts'));
  await timedImport('browser', () => import('../lib/acquisitionBrowserBot.ts'));
}

main()
  .then(() => {
    console.log('[acquisition-browser] isolated imports complete pid=' + process.pid);
    setTimeout(() => process.exit(0), 50);
  })
  .catch((error) => {
    console.error('[acquisition-browser] isolated worker fatal:', error?.message || error);
    process.exit(1);
  });
