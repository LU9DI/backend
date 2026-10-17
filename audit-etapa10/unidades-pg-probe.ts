/**
 * ETAPA 10 — probe Postgres: a seção de unidades do relatório usa unidades.slug.
 *
 * Cria o schema real de unidades (ensureUnidadesSchema) no banco descartável e
 * verifica se a coluna slug existe — a mesma query do relatório profissional.
 *
 * Uso:
 *   $env:DATABASE_URL='postgres://postgres:etapa9audit@localhost:55432/filtra_etapa10'
 *   $env:PGSSL='0'
 *   node_modules\.bin\tsx.cmd audit-etapa10\unidades-pg-probe.ts
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'auditoria-etapa10-secret-nao-usar-em-producao-0123456789';

async function main() {
  const { initDB, getDb, closeDB } = await import('../lib/db.js');
  const { ensureUnidadesSchema } = await import('../lib/unidades.js');
  await initDB();
  const db = getDb();

  let ensureErro = '';
  try {
    await ensureUnidadesSchema(db);
  } catch (e: any) {
    ensureErro = String(e?.message || e).slice(0, 300);
  }

  let colunaSlugExiste = false;
  let queryErro = '';
  try {
    await db.all('SELECT id, nome, slug FROM unidades LIMIT 1');
    colunaSlugExiste = true;
  } catch (e: any) {
    queryErro = String(e?.message || e).slice(0, 300);
  }

  const resultado = {
    engine: 'postgres',
    banco: 'filtra_etapa10 (descartavel)',
    ensureUnidadesSchema: ensureErro ? `ERRO: ${ensureErro}` : 'ok',
    coluna_slug_existe: colunaSlugExiste,
    erro_da_query_do_relatorio: queryErro || null,
    veredito: colunaSlugExiste
      ? 'slug existe no Postgres (comportamento difere do SQLite)'
      : 'DEFEITO CONFIRMADO TAMBEM NO POSTGRES: a secao de unidades do relatorio nao popula',
  };
  console.log('UNIDADES-PG-PROBE ' + JSON.stringify(resultado));
  await closeDB().catch(() => undefined);
  process.exit(colunaSlugExiste ? 0 : 3);
}

main().catch((e) => {
  console.error('ERRO FATAL:', e);
  process.exit(1);
});
