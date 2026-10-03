import 'dotenv/config';

console.log('[acquisition-browser] isolated entry pid=' + process.pid + ' child=' + String(process.env.ACQUISITION_BROWSER_CHILD || ''));

async function main() {
  const { initDB, getDb } = await import('../lib/db.ts');
  console.log('[acquisition-browser] initializing isolated database');
  await initDB();
  console.log('[acquisition-browser] isolated database initialized');

  const db = getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS acquisition_browser_worker_lock (
    id INTEGER PRIMARY KEY,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const lock = await db.run(`INSERT INTO acquisition_browser_worker_lock (id, locked_at)
    VALUES (1, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE
      SET locked_at = CURRENT_TIMESTAMP
      WHERE acquisition_browser_worker_lock.locked_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes'`);
  if (!Number(lock?.changes || 0)) {
    console.log('[acquisition-browser] isolated worker skipped: another cycle is active');
    return;
  }

  try {
    const { runAcquisitionBrowserBotTick } = await import('../lib/acquisitionBrowserBot.ts');
    console.log('[acquisition-browser] isolated browser module imported');
    await runAcquisitionBrowserBotTick(true);
  } finally {
    await db.run('DELETE FROM acquisition_browser_worker_lock WHERE id=1').catch(() => undefined);
    console.log('[acquisition-browser] isolated worker lock released');
  }
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
