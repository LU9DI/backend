import { Client } from 'pg';

const sourceUrl = (process.env.DATABASE_URL || '').trim();
const targetPassword = (process.env.SUPABASE_DB_PASSWORD || '').trim();
const targetHost = (process.env.SUPABASE_DB_HOST || 'aws-0-us-west-2.pooler.supabase.com').trim();
const targetUser = (process.env.SUPABASE_DB_USER || 'postgres.xutrgqurdrpujxjraynm').trim();
const targetDb = (process.env.SUPABASE_DB_NAME || 'postgres').trim();
const targetPort = Number(process.env.SUPABASE_DB_PORT || 5432);
const marker = 'render-to-supabase-2026-09-27-v2';

const q = (s: string) => '"' + s.replaceAll('"', '""') + '"';

async function rowFingerprint(client: Client, table: string): Promise<{ count: number; fingerprint: string }> {
  const sql = `
    SELECT COUNT(*)::bigint AS count,
      COALESCE(md5(string_agg(md5(to_jsonb(t)::text), '' ORDER BY to_jsonb(t)::text)), md5('')) AS fingerprint
    FROM ${q(table)} t`;
  const row = (await client.query(sql)).rows[0];
  return { count: Number(row.count), fingerprint: String(row.fingerprint) };
}

export async function main() {
  if (!sourceUrl) throw new Error('DATABASE_URL não configurada.');
  if (!targetPassword) throw new Error('SUPABASE_DB_PASSWORD não configurada.');

  let sourceInfo = 'unknown';
  try {
    const u = new URL(sourceUrl);
    sourceInfo = u.username + '@' + u.hostname + ':' + (u.port || '5432') + '/' + u.pathname.replace(/^\//, '');
  } catch {}

  console.log('[MIGRATION] source=' + sourceInfo + ' target=' + targetUser + '@' + targetHost + ':' + targetPort + '/' + targetDb);

  const source = new Client({ connectionString: sourceUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  const target = new Client({
    host: targetHost, port: targetPort, database: targetDb, user: targetUser, password: targetPassword,
    ssl: { rejectUnauthorized: false, serverName: targetHost }, connectionTimeoutMillis: 15000,
  });

  try {
    await source.connect();
    console.log('[MIGRATION] source connected');
    await target.connect();
    console.log('[MIGRATION] target connected as ' + targetUser);

    await target.query(`CREATE TABLE IF NOT EXISTS "__filtra_migrations" (
      id text PRIMARY KEY, completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, details jsonb)`);

    if ((await target.query('SELECT 1 FROM "__filtra_migrations" WHERE id=$1', [marker])).rowCount) {
      console.log('[MIGRATION] marker already present; nothing to do');
      return;
    }

    const sequences = (await source.query(`
      SELECT sequence_name FROM information_schema.sequences
      WHERE sequence_schema='public' ORDER BY sequence_name`)).rows;

    for (const s of sequences) {
      const sequence = String(s.sequence_name);
      const exists = await target.query(
        "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1 AND c.relkind='S'",
        [sequence],
      );
      if (!exists.rowCount) await target.query('CREATE SEQUENCE ' + q(sequence));
    }

    const tables = (await source.query(`
      SELECT c.relname AS table_name FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`)).rows;

    const report: Record<string, any> = {};

    for (const t of tables) {
      const table = String(t.table_name);
      const cols = (await source.query(`
        SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
          a.attnotnull AS not_null, pg_get_expr(d.adbin,d.adrelid) AS default_expr,
          a.attidentity AS identity_kind
        FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE n.nspname='public' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY a.attnum`, [table])).rows;

      const existing = (await target.query(
        "SELECT column_name AS name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1", [table],
      )).rows;
      const have = new Set(existing.map((r: any) => r.name));

      if (!existing.length) {
        const defs = cols.map((c: any) => {
          let d = q(c.name) + ' ' + c.type;
          if (c.identity_kind) d += ' GENERATED ' + (c.identity_kind === 'a' ? 'ALWAYS' : 'BY DEFAULT') + ' AS IDENTITY';
          else if (c.default_expr) d += ' DEFAULT ' + c.default_expr;
          if (c.not_null) d += ' NOT NULL';
          return d;
        });
        await target.query('CREATE TABLE ' + q(table) + ' (' + defs.join(', ') + ')');
      } else {
        for (const c of cols) {
          if (have.has(c.name)) continue;
          let ddl = 'ALTER TABLE ' + q(table) + ' ADD COLUMN ' + q(c.name) + ' ' + c.type;
          if (c.default_expr) ddl += ' DEFAULT ' + c.default_expr;
          if (c.not_null) ddl += ' NOT NULL';
          await target.query(ddl);
        }
      }

      const sourceFp = await rowFingerprint(source, table);
      const targetFp = await rowFingerprint(target, table);

      if (targetFp.count > 0) {
        if (targetFp.count !== sourceFp.count || targetFp.fingerprint !== sourceFp.fingerprint) {
          throw new Error('Conflito de dados em ' + table + ': source=' + sourceFp.count + '/' + sourceFp.fingerprint +
            ' target=' + targetFp.count + '/' + targetFp.fingerprint);
        }
        report[table] = { source: sourceFp.count, target: targetFp.count, fingerprint: sourceFp.fingerprint, action: 'already-migrated' };
        continue;
      }

      if (sourceFp.count > 0) {
        const names = cols.map((c: any) => c.name);
        const rows = (await source.query('SELECT * FROM ' + q(table))).rows;
        for (let i = 0; i < rows.length; i += 200) {
          const batch = rows.slice(i, i + 200);
          const vals: any[] = [];
          const tuples = batch.map((r: any) => '(' + names.map((name: string) => {
            vals.push(r[name]); return '$' + vals.length;
          }).join(',') + ')').join(',');
          await target.query('INSERT INTO ' + q(table) + ' (' + names.map(q).join(',') + ') VALUES ' + tuples, vals);
        }
      }

      const after = await rowFingerprint(target, table);
      if (after.count !== sourceFp.count || after.fingerprint !== sourceFp.fingerprint) {
        throw new Error('Validação de dados falhou em ' + table);
      }
      report[table] = { source: sourceFp.count, target: after.count, fingerprint: after.fingerprint, action: 'copied' };
    }

    for (const t of tables) {
      const table = String(t.table_name);
      const cols = (await source.query(`
        SELECT a.attname AS name FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY a.attnum`, [table])).rows;

      for (const c of cols) {
        const sourceSeq = (await source.query(
          'SELECT pg_get_serial_sequence($1,$2) AS seq', ['public.' + table, c.name],
        )).rows[0]?.seq;
        if (!sourceSeq) continue;

        const targetSeq = (await target.query(
          'SELECT pg_get_serial_sequence($1,$2) AS seq', ['public.' + table, c.name],
        )).rows[0]?.seq;
        if (!targetSeq) continue;

        const max = (await target.query('SELECT MAX(' + q(c.name) + ') AS max FROM ' + q(table))).rows[0]?.max;
        if (max !== null && max !== undefined) {
          await target.query('SELECT setval($1::regclass,$2,true)', [String(targetSeq), max]);
        }
      }
    }

    const finalReport: Record<string, any> = {};
    for (const t of tables) {
      const table = String(t.table_name);
      const sourceFp = await rowFingerprint(source, table);
      const targetFp = await rowFingerprint(target, table);
      if (sourceFp.count !== targetFp.count || sourceFp.fingerprint !== targetFp.fingerprint) {
        throw new Error('Validação final falhou em ' + table);
      }
      finalReport[table] = { source: sourceFp.count, target: targetFp.count, fingerprint: targetFp.fingerprint, action: report[table]?.action || 'validated' };
    }

    await target.query('INSERT INTO "__filtra_migrations"(id,details) VALUES($1,$2)', [marker, JSON.stringify(finalReport)]);
    console.log('[MIGRATION] Render -> Supabase concluída e validada.', finalReport);
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
}
