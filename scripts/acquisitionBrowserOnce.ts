import 'dotenv/config';
import crypto from 'node:crypto';

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
  await db.exec(`CREATE TABLE IF NOT EXISTS acquisition_browser_cycles (
    id UUID PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMPTZ,
    duration_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    selected INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    submitted_unconfirmed INTEGER NOT NULL DEFAULT 0,
    channel_found INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    pending INTEGER NOT NULL DEFAULT 0,
    error TEXT
  )`);

  const lock = await db.run(`INSERT INTO acquisition_browser_worker_lock (id, locked_at)
    VALUES (1, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE
      SET locked_at = CURRENT_TIMESTAMP
      WHERE acquisition_browser_worker_lock.locked_at < CURRENT_TIMESTAMP - INTERVAL '5 minutes'`);
  if (!Number(lock?.changes || 0)) {
    const stale = await db.run(`DELETE FROM acquisition_browser_worker_lock
      WHERE id=1 AND locked_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'`);
    if (!Number(stale?.changes || 0)) {
      console.log('[acquisition-browser] isolated worker skipped: another cycle is active');
      return;
    }
    const retryLock = await db.run(`INSERT INTO acquisition_browser_worker_lock (id, locked_at)
      VALUES (1, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE
        SET locked_at = CURRENT_TIMESTAMP
        WHERE acquisition_browser_worker_lock.locked_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'`);
    if (!Number(retryLock?.changes || 0)) {
      console.log('[acquisition-browser] isolated worker skipped: lock contention');
      return;
    }
    console.log('[acquisition-browser] recovered stale worker lock');
  }

  const cycleId = crypto.randomUUID();
  const startedAt = Date.now();
  await db.run(
    `INSERT INTO acquisition_browser_cycles (id, started_at, status) VALUES (?, CURRENT_TIMESTAMP, 'running')`,
    [cycleId],
  );

  try {
    const { runAcquisitionBrowserBotTick } = await import('../lib/acquisitionBrowserBot.ts');
    console.log('[acquisition-browser] isolated browser module imported');
    await runAcquisitionBrowserBotTick(true);

    const summary = await db.get(`
      SELECT
        COUNT(*) FILTER (WHERE browser_status='sent' AND browser_last_at >= CURRENT_TIMESTAMP - INTERVAL '3 minutes')::int AS sent,
        COUNT(*) FILTER (WHERE browser_status='contact_attempted' AND browser_last_at >= CURRENT_TIMESTAMP - INTERVAL '3 minutes')::int AS submitted_unconfirmed,
        COUNT(*) FILTER (WHERE browser_status='channel_found' AND browser_last_at >= CURRENT_TIMESTAMP - INTERVAL '3 minutes')::int AS channel_found,
        COUNT(*) FILTER (WHERE browser_status='failed' AND browser_last_at >= CURRENT_TIMESTAMP - INTERVAL '3 minutes')::int AS failed,
        COUNT(*) FILTER (WHERE browser_status='pending' AND browser_last_at >= CURRENT_TIMESTAMP - INTERVAL '3 minutes')::int AS pending
      FROM leads
    `);
    const sent = Number(summary?.sent || 0);
    const submitted = Number(summary?.submitted_unconfirmed || 0);
    const channelFound = Number(summary?.channel_found || 0);
    const failed = Number(summary?.failed || 0);
    const pending = Number(summary?.pending || 0);
    const selected = sent + submitted + channelFound + failed + pending;

    await db.run(
      `UPDATE acquisition_browser_cycles
       SET finished_at=CURRENT_TIMESTAMP, duration_ms=?, status='completed',
           selected=?, sent=?, submitted_unconfirmed=?, channel_found=?, failed=?, pending=?
       WHERE id=?`,
      [Date.now() - startedAt, selected, sent, submitted, channelFound, failed, pending, cycleId],
    );

    console.log('[acquisition-browser] cycle telemetry', JSON.stringify({
      cycle_id: cycleId,
      duration_ms: Date.now() - startedAt,
      selected,
      sent,
      submitted_unconfirmed: submitted,
      channel_found: channelFound,
      failed,
      pending,
    }));
  } catch (error: any) {
    await db.run(
      `UPDATE acquisition_browser_cycles
       SET finished_at=CURRENT_TIMESTAMP, duration_ms=?, status='failed', error=?
       WHERE id=?`,
      [Date.now() - startedAt, String(error?.message || error).slice(0, 2000), cycleId],
    ).catch(() => undefined);
    throw error;
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