import { Client } from 'pg';
import crypto from 'crypto';

const sourceUrl = (process.env.DATABASE_URL || '').trim();
const targetPassword = (process.env.SUPABASE_DB_PASSWORD || '').trim();
const targetHost = (process.env.SUPABASE_DB_HOST || 'aws-0-us-west-2.pooler.supabase.com').trim();
const targetUser = (process.env.SUPABASE_DB_USER || 'postgres.xutrgqurdrpujxjraynm').trim();
const targetDb = (process.env.SUPABASE_DB_NAME || 'postgres').trim();
const targetPort = Number(process.env.SUPABASE_DB_PORT || 5432);
const marker = 'render-to-supabase-2026-09-27-v2';

const q = (s: string) => '"' + s.replaceAll('"', '""') + '"';

function stableValue(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out: Record<string, any>, key) => {
      out[key] = stableValue(value[key]);
      return out;
    }, {});
  }
  return value;
}

function rowsFingerprint(rows: any[]): string {
  const normalized = rows.map((row) => JSON.stringify(stableValue(row))).sort();
  return crypto.createHash('sha256').update(normalized.join('\n')).digest('hex');
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

      const names = cols.map((c: any) => c.name);
      const sourceRows = (await source.query('SELECT * FROM ' + q(table))).rows;
      const targetRows = (await target.query('SELECT ' + names.map(q).join(',') + ' FROM ' + q(table))).rows;

      const sourceCount = sourceRows.length;
      const targetCount = targetRows.length;

      if (targetCount > 0) {
        if (targetCount !== sourceCount || rowsFingerprint(targetRows) !== rowsFingerprint(sourceRows)) {
          throw new Error('Conflito de dados em ' + table + ': source=' + sourceCount + '/' + rowsFingerprint(sourceRows) +
            ' target=' + targetCount + '/' + rowsFingerprint(targetRows));
        }
        report[table] = { source: sourceCount, target: targetCount, fingerprint: rowsFingerprint(sourceRows), action: 'already-migrated' };
        continue;
      }

      if (sourceCount > 0) {
        for (let i = 0; i < sourceRows.length; i += 200) {
          const batch = sourceRows.slice(i, i + 200);
          const vals: any[] = [];
          const tuples = batch.map((r: any) => '(' + names.map((name: string) => {
            vals.push(r[name]); return '
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
      const names = (await source.query(`
        SELECT a.attname AS name
        FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY a.attnum`, [table])).rows.map((r: any) => r.name);
      const sourceRows = (await source.query('SELECT ' + names.map(q).join(',') + ' FROM ' + q(table))).rows;
      const targetRows = (await target.query('SELECT ' + names.map(q).join(',') + ' FROM ' + q(table))).rows;
      if (sourceRows.length !== targetRows.length || rowsFingerprint(sourceRows) !== rowsFingerprint(targetRows)) {
        throw new Error('Validação final falhou em ' + table);
      }
      finalReport[table] = { source: sourceRows.length, target: targetRows.length, fingerprint: rowsFingerprint(targetRows), action: report[table]?.action || 'validated' };
    }

    await target.query('INSERT INTO "__filtra_migrations"(id,details) VALUES($1,$2)', [marker, JSON.stringify(finalReport)]);
    console.log('[MIGRATION] Render -> Supabase concluída e validada.', finalReport);
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
}
 + vals.length;
          }).join(',') + ')').join(',');
          await target.query('INSERT INTO ' + q(table) + ' (' + names.map(q).join(',') + ') VALUES ' + tuples, vals);
        }
      }

      const afterRows = (await target.query('SELECT ' + names.map(q).join(',') + ' FROM ' + q(table))).rows;
      if (afterRows.length !== sourceCount || rowsFingerprint(afterRows) !== rowsFingerprint(sourceRows)) {
        throw new Error('Validação de dados falhou em ' + table);
      }
      report[table] = { source: sourceCount, target: afterRows.length, fingerprint: rowsFingerprint(sourceRows), action: 'copied' };
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
      const fingerprintColumns = (await source.query(`
        SELECT a.attname AS name
        FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=$1 AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY a.attnum`, [table])).rows.map((r: any) => r.name);
      const sourceFp = await rowFingerprint(source, table, fingerprintColumns);
      const targetFp = await rowFingerprint(target, table, fingerprintColumns);
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
