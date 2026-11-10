/**
 * Inicialização central de schema (PostgreSQL e SQLite).
 *
 * Toda a DDL do núcleo vive aqui, em `runCentralMigrations`, e roda apenas
 * durante `initDB()`. Caminhos de requisição usam `requireSchema`/`assert*`
 * para *verificar* o schema e falhar explicitamente quando algo está ausente —
 * nunca para corrigi-lo silenciosamente.
 *
 * Idempotência: cada alteração consulta antes o catálogo (PostgreSQL) ou
 * `PRAGMA table_info`/`PRAGMA index_list` (SQLite). Nada presume que bancos
 * antigos compartilham o mesmo schema.
 */
import type { Database } from 'sqlite';
import type { PgDatabase } from './db.pg.js';

/**
 * Advisory lock global de migração PostgreSQL.
 *
 * Chave estável e documentada: FNV-1a 64 bits de
 * `filtra-ia:postgres:migrations:v1`, truncada para 63 bits (int8 positivo)
 * para caber em `pg_advisory_lock(bigint)`.
 *
 * Nunca altere este valor sem uma migração coordenada: processos antigos e
 * novos precisam disputar exatamente o mesmo lock.
 */
export const PG_MIGRATION_LOCK_KEY = 8005998760133593297n;

function isPgDatabase(db: Database | PgDatabase): db is Database & PgDatabase {
  db = db as Database;
  return typeof (db as unknown as Partial<PgDatabase>).withMigrationLock === 'function';
}

/** Nomes reais das colunas (caixa preservada). Vazio quando a tabela não existe. */
export async function tableColumnNames(db: Database | PgDatabase, table: string): Promise<string[]> {
  db = db as Database;
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return (rows || []).map((row: any) => String(row.name));
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Colunas de uma tabela, minúsculas. Vazio quando a tabela não existe. */
export async function tableColumns(db: Database | PgDatabase, table: string): Promise<string[]> {
  db = db as Database;
  const rows = await db.all(`PRAGMA table_info(${table})`);
  return (rows || []).map((row: any) => String(row.name).toLowerCase());
}

export async function tableExists(db: Database | PgDatabase, table: string): Promise<boolean> {
  db = db as Database;
  return (await tableColumns(db, table)).length > 0;
}

export async function columnExists(db: Database | PgDatabase, table: string, column: string): Promise<boolean> {
  db = db as Database;
  return (await tableColumns(db, table)).includes(column.toLowerCase());
}

export async function indexExists(db: Database | PgDatabase, table: string, index: string): Promise<boolean> {
  db = db as Database;
  if (isPgDatabase(db)) {
    const row = await db.get(
      `SELECT 1 AS ok FROM pg_indexes WHERE schemaname = 'public' AND lower(indexname) = ? LIMIT 1`,
      [index.toLowerCase()],
    );
    return Boolean(row);
  }
  const rows = await db.all(`PRAGMA index_list(${table})`);
  return (rows || []).some((row: any) => String(row.name).toLowerCase() === index.toLowerCase());
}

export type SchemaRequirements = {
  tables?: string[];
  columns?: Record<string, string[]>;
  indexes?: Array<{ table: string; name: string }>;
};

/**
 * Verifica estruturas obrigatórias sem executar DDL.
 * Registra o problema e lança erro explícito quando algo está ausente.
 */
export async function requireSchema(db: Database | PgDatabase, requirements: SchemaRequirements): Promise<void> {
  db = db as Database;
  const missing: string[] = [];

  for (const table of requirements.tables || []) {
    if (!(await tableExists(db, table))) missing.push(`tabela ${table}`);
  }

  for (const [table, columns] of Object.entries(requirements.columns || {})) {
    if (!(await tableExists(db, table))) {
      missing.push(`tabela ${table}`);
      continue;
    }
    const existing = await tableColumns(db, table);
    for (const column of columns) {
      if (!existing.includes(column.toLowerCase())) missing.push(`coluna ${table}.${column}`);
    }
  }

  for (const index of requirements.indexes || []) {
    if (!(await indexExists(db, index.table, index.name))) {
      missing.push(`índice ${index.name} (${index.table})`);
    }
  }

  if (missing.length > 0) {
    const detail = missing.join(', ');
    console.error(`[schema] Estruturas obrigatórias ausentes: ${detail}`);
    throw new Error(
      `Schema desatualizado: ${detail}. Execute initDB()/runCentralMigrations() antes de usar este recurso.`,
    );
  }
}

/**
 * Colunas de `reviews` que a aplicação usa. A DDL de todas elas vive nesta
 * migração central; os serviços apenas verificam a existência com
 * `requireReviewSchema`/`requireSchema`.
 */
export const REVIEW_COLUMNS = [
  'createdAt',
  'is_test',
  'ip_hash',
  'fraud_flags',
  'origin',
  'client_whatsapp',
  'sentiment',
  'sentiment_score',
  'sentiment_source',
  'locale',
  'unidade_id',
  'treated_at',
  'treated_note',
] as const;

export type ReviewColumn = (typeof REVIEW_COLUMNS)[number];

/** Verificação (sem DDL) das colunas de reviews usadas por um serviço. */
export async function requireReviewSchema(
  db: Database | PgDatabase,
  columns: readonly string[] = REVIEW_COLUMNS,
): Promise<void> {
  await requireSchema(db, { columns: { reviews: [...columns] } });
}

/** Definições reais de índices (nome, tabela, DDL), sem placeholders. */
export type IndexDefinition = {
  name: string;
  table: string;
  definition: string;
  unique: boolean;
};

function normalizeIndexDefinition(definition: string): string {
  return String(definition || '').replace(/\s+/g, ' ').trim();
}

/**
 * Snapshot real dos índices. PostgreSQL: `pg_indexes` (indexname, tablename,
 * indexdef). SQLite: `PRAGMA index_list` + `sqlite_master` (e `PRAGMA
 * index_info` para índices automáticos sem DDL).
 */
export async function listIndexDefinitions(
  db: Database | PgDatabase,
  tables?: readonly string[],
): Promise<IndexDefinition[]> {
  const allowed = tables ? new Set(tables) : null;
  if (isPgDatabase(db)) {
    const rows = await db.all(
      `SELECT indexname AS name, tablename AS table, indexdef AS definition
         FROM pg_indexes
        WHERE schemaname = 'public'
        ORDER BY tablename, indexname`,
    );
    return (rows as any[])
      .map((row) => ({
        name: String(row.name),
        table: String(row.table),
        definition: normalizeIndexDefinition(String(row.definition)),
        unique: /^CREATE UNIQUE INDEX/i.test(String(row.definition)),
      }))
      .filter((row) => !allowed || allowed.has(row.table));
  }

  const tableRows: any[] = await db.all(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  const result: IndexDefinition[] = [];
  for (const tableRow of tableRows) {
    const table = String(tableRow.name);
    if (allowed && !allowed.has(table)) continue;
    const indexes: any[] = await db.all(`PRAGMA index_list(${table})`);
    for (const index of indexes || []) {
      const name = String(index.name);
      const master: any = await db.get(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
        [name],
      );
      let definition = master?.sql ? String(master.sql) : '';
      if (!definition) {
        const info: any[] = await db.all(`PRAGMA index_info(${name})`);
        const columns = (info || []).map((column) => String(column.name)).join(', ');
        definition = `CREATE ${Number(index.unique) ? 'UNIQUE ' : ''}INDEX ${name} ON ${table} (${columns})`;
      }
      result.push({
        name,
        table,
        definition: normalizeIndexDefinition(definition),
        unique: Boolean(Number(index.unique)),
      });
    }
  }
  return result.sort((a, b) => a.table.localeCompare(b.table) || a.name.localeCompare(b.name));
}

async function createTableIfMissing(db: Database | PgDatabase, table: string, ddl: string): Promise<void> {
  db = db as Database;
  if (await tableExists(db, table)) return;
  await db.exec(ddl);
}

async function addColumnIfMissing(
  db: Database | PgDatabase,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  if (await columnExists(db, table, column)) return;
  await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function createIndexIfMissing(
  db: Database | PgDatabase,
  table: string,
  name: string,
  ddl: string,
): Promise<void> {
  if (await indexExists(db, table, name)) return;
  await db.exec(ddl);
}

async function migrateCoreTables(db: Database | PgDatabase): Promise<void> {
  db = db as Database;
  await createTableIfMissing(
    db,
    'empresas',
    `CREATE TABLE IF NOT EXISTS empresas (
      id TEXT PRIMARY KEY,
      cnpj TEXT UNIQUE NOT NULL,
      nome_empresa TEXT NOT NULL,
      slug TEXT UNIQUE,
      status TEXT DEFAULT 'trial',
      plan TEXT DEFAULT 'trial',
      criado_em TIMESTAMPTZ NOT NULL,
      expira_em TIMESTAMPTZ NOT NULL,
      google_review_url TEXT,
      voice_style TEXT,
      empresa_pai_id TEXT,
      whatsapp_suporte TEXT
    )`,
  );

  await createTableIfMissing(
    db,
    'usuarios',
    `CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY,
      cnpj TEXT NOT NULL,
      nome_funcionario TEXT NOT NULL,
      empresa_id TEXT NOT NULL,
      senha_hash TEXT NOT NULL
    )`,
  );

  await createTableIfMissing(
    db,
    'reviews',
    `CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT,
      name TEXT,
      rating INTEGER,
      comment TEXT,
      ai_reply TEXT,
      ai_tags TEXT,
      createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
  );

  await createTableIfMissing(
    db,
    'ai_usage',
    `CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT,
      tipo TEXT NOT NULL,
      tokens INTEGER NOT NULL DEFAULT 0,
      criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
  );

  await createTableIfMissing(
    db,
    'usage',
    `CREATE TABLE IF NOT EXISTS usage (
      plan TEXT NOT NULL,
      month TEXT NOT NULL,
      tags INTEGER DEFAULT 0,
      respostas INTEGER DEFAULT 0,
      PRIMARY KEY (plan, month)
    )`,
  );


  await createTableIfMissing(
    db,
    'trial_registrations',
    `CREATE TABLE IF NOT EXISTS trial_registrations (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      ip_hash TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
  );

  await createIndexIfMissing(
    db,
    'reviews',
    'idx_reviews_empresa',
    'CREATE INDEX IF NOT EXISTS idx_reviews_empresa ON reviews(empresa_id)',
  );
  await createIndexIfMissing(
    db,
    'empresas',
    'idx_empresas_cnpj',
    'CREATE INDEX IF NOT EXISTS idx_empresas_cnpj ON empresas(cnpj)',
  );
  await createIndexIfMissing(
    db,
    'empresas',
    'idx_empresas_slug',
    'CREATE INDEX IF NOT EXISTS idx_empresas_slug ON empresas(slug)',
  );
}

/**
 * Migra a data de criação das avaliações preservando a série histórica.
 *
 * O adapter deste backend reescreve `createdAt` sem aspas para o identificador
 * citado `"createdAt"`; por isso o canônico é `createdAt` exato nos dois
 * dialetos. Fontes históricas aceitas: `createdat` (DDL antiga sem aspas no
 * PostgreSQL) e `created_at` (schemas em snake_case).
 *
 * A coluna é criada SEM DEFAULT e preenchida por backfill; o default do
 * PostgreSQL é aplicado depois e vale apenas para linhas futuras.
 */
async function migrateReviewsCreatedAt(db: Database | PgDatabase): Promise<void> {
  db = db as Database;
  const pg = isPgDatabase(db);
  const actual = await tableColumnNames(db, 'reviews');
  if (actual.length === 0) return;

  const lower = new Set(actual.map((name) => name.toLowerCase()));
  const canonical = 'createdAt';
  // SQLite é case-insensitive para identificadores: se já existe `createdat`,
  // ele atende `createdAt` e criar outra coluna seria um erro de duplicidade.
  const hasCanonical = pg ? actual.includes(canonical) : lower.has('createdat');

  if (!hasCanonical) {
    await db.exec(
      `ALTER TABLE reviews ADD COLUMN ${canonical} ${pg ? 'TIMESTAMPTZ' : 'DATETIME'}`,
    );
    actual.push(canonical);
  }

  const canonicalName = pg
    ? canonical
    : actual.find((name) => name.toLowerCase() === 'createdat') || canonical;

  const sources = actual.filter((name) => {
    if (name === canonicalName) return false;
    const normalized = name.toLowerCase();
    return normalized === 'createdat' || normalized === 'created_at';
  });
  sources.sort((a, b) => {
    const rank = (name: string) =>
      name === 'createdat' ? 0 : name.toLowerCase() === 'created_at' ? 1 : 2;
    return rank(a) - rank(b);
  });

  for (const source of sources) {
    // Só preenche lacunas: datas válidas no canônico nunca são sobrescritas.
    await db.exec(
      `UPDATE reviews SET ${quoteIdentifier(canonicalName)} = ${quoteIdentifier(source)} ` +
        `WHERE ${quoteIdentifier(canonicalName)} IS NULL AND ${quoteIdentifier(source)} IS NOT NULL`,
    );
  }

  if (pg) {
    await db.exec(
      `ALTER TABLE reviews ALTER COLUMN ${quoteIdentifier(canonicalName)} SET DEFAULT CURRENT_TIMESTAMP`,
    );
  }
}

async function migrateReviewsColumns(db: Database | PgDatabase): Promise<void> {
  db = db as Database;
  await migrateReviewsCreatedAt(db);
  // Tipos compatíveis com SQLite e PostgreSQL; o adapter traduz REAL para
  // DOUBLE PRECISION no PostgreSQL. Nenhuma coluna existente é recriada.
  const definitions: Record<string, string> = {
    is_test: 'INTEGER DEFAULT 0',
    ip_hash: 'TEXT',
    fraud_flags: 'TEXT',
    origin: 'TEXT',
    client_whatsapp: 'TEXT',
    sentiment: 'TEXT',
    sentiment_score: 'REAL',
    sentiment_source: 'TEXT',
    locale: 'TEXT',
    unidade_id: 'TEXT',
    treated_at: 'TIMESTAMPTZ',
    treated_note: 'TEXT',
  };
  for (const [column, definition] of Object.entries(definitions)) {
    await addColumnIfMissing(db, 'reviews', column, definition);
  }
}

async function migrateAuthSchema(db: Database | PgDatabase): Promise<void> {
  db = db as Database;
  await addColumnIfMissing(db, 'usuarios', 'email', 'TEXT');

  await createTableIfMissing(
    db,
    'password_resets',
    `CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      usuario_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      expira_em TIMESTAMPTZ NOT NULL,
      usado INTEGER DEFAULT 0,
      criado_em TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,
  );

  // A aplicação normaliza e-mails com trim + lowercase antes de consultar
  // ou inserir. Detectar colisões com a mesma regra ANTES dos índices evita
  // que contas legadas ambíguas recebam acesso incorreto após o deploy.
  const duplicateEmails = await db.get(
    `SELECT COUNT(*) AS duplicate_groups,
            COALESCE(SUM(user_count), 0) AS affected_users
       FROM (
         SELECT COUNT(*) AS user_count
           FROM usuarios
          WHERE email IS NOT NULL
          GROUP BY LOWER(TRIM(email))
         HAVING COUNT(*) > 1
       ) AS duplicates`,
  ) as { duplicate_groups?: number | string; affected_users?: number | string } | undefined;
  const duplicateGroups = Number(duplicateEmails?.duplicate_groups || 0);
  if (duplicateGroups > 0) {
    const affectedUsers = Number(duplicateEmails?.affected_users || 0);
    throw new Error(
      `Migração de autenticação bloqueada: ${duplicateGroups} grupo(s) de e-mail duplicado(s) afetam ${affectedUsers} usuário(s), considerando trim + lowercase. Corrija as contas conflitantes de forma auditada e execute a migração novamente; nenhum usuário foi alterado.`,
    );
  }

  await createIndexIfMissing(
    db,
    'usuarios',
    'idx_usuarios_email',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email)',
  );
  await createIndexIfMissing(
    db,
    'usuarios',
    'ux_usuarios_email_normalized',
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_email_normalized ON usuarios(LOWER(TRIM(email)))',
  );
  await createIndexIfMissing(
    db,
    'password_resets',
    'idx_password_resets_usuario',
    'CREATE INDEX IF NOT EXISTS idx_password_resets_usuario ON password_resets(usuario_id, usado)',
  );
}

async function migrateMfaSchema(db: Database | PgDatabase): Promise<void> {
  db = db as Database;
  await addColumnIfMissing(db, 'usuarios', 'mfa_secret', 'TEXT');
  await addColumnIfMissing(db, 'usuarios', 'mfa_enabled', 'INTEGER DEFAULT 0');
  await addColumnIfMissing(db, 'usuarios', 'mfa_backup_hashes', 'TEXT');
  await addColumnIfMissing(db, 'usuarios', 'mfa_pending_secret', 'TEXT');
}

async function migrateDotActionSchema(db: Database | PgDatabase): Promise<void> {
  db = db as Database;
  await createTableIfMissing(
    db,
    'dot_action_queue',
    `CREATE TABLE IF NOT EXISTS dot_action_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT NOT NULL,
      decision_id INTEGER NOT NULL,
      option_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'prepared',
      approved_at TEXT,
      executed_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    )`,
  );
  await createIndexIfMissing(
    db,
    'dot_action_queue',
    'ux_dot_action_queue_decision_option',
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_dot_action_queue_decision_option ON dot_action_queue(empresa_id, decision_id, option_id)',
  );
  await createIndexIfMissing(
    db,
    'dot_action_queue',
    'ux_dot_action_queue_one_active_decision',
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_dot_action_queue_one_active_decision ON dot_action_queue(empresa_id, decision_id) WHERE status IN ('prepared','approved','executing')",
  );

  await createTableIfMissing(
    db,
    'dot_action_audit',
    `CREATE TABLE IF NOT EXISTS dot_action_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT NOT NULL,
      action_id INTEGER NOT NULL,
      decision_id INTEGER,
      event TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    )`,
  );
  // Bancos criados antes do campo metadata: CREATE TABLE IF NOT EXISTS não
  // altera tabelas existentes, por isso a verificação explícita.
  await addColumnIfMissing(db, 'dot_action_audit', 'metadata', 'TEXT');
  await createIndexIfMissing(
    db,
    'dot_action_audit',
    'idx_dot_action_audit_empresa',
    'CREATE INDEX IF NOT EXISTS idx_dot_action_audit_empresa ON dot_action_audit(empresa_id, created_at)',
  );
  await createIndexIfMissing(
    db,
    'dot_action_audit',
    'idx_dot_action_audit_action',
    'CREATE INDEX IF NOT EXISTS idx_dot_action_audit_action ON dot_action_audit(empresa_id, action_id, created_at)',
  );

  // Marcador EXPLÍCITO e RESTRITO de migração histórica. A ausência de evento
  // `prepared` bloqueia a aprovação; a única exceção é uma linha verificável
  // nesta tabela, criada por operação administrativa deliberada e escopada por
  // (empresa, ação). Nada é inserido automaticamente pelo código.
  await createTableIfMissing(
    db,
    'dot_action_legacy_approval_markers',
    `CREATE TABLE IF NOT EXISTS dot_action_legacy_approval_markers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT NOT NULL,
      action_id INTEGER NOT NULL,
      marker TEXT NOT NULL,
      reason TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    )`,
  );
  await createIndexIfMissing(
    db,
    'dot_action_legacy_approval_markers',
    'ux_dot_action_legacy_marker',
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_dot_action_legacy_marker ON dot_action_legacy_approval_markers(empresa_id, action_id, marker)',
  );

  // Tabelas usadas pelo gateway de execução atômica e pelos follow-ups.
  // Centralizadas aqui para que nenhuma requisição precise executar DDL.
  await createTableIfMissing(
    db,
    'dot_internal_cases',
    `CREATE TABLE IF NOT EXISTS dot_internal_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT NOT NULL,
      decision_id INTEGER NOT NULL,
      action_id INTEGER NOT NULL,
      event_id INTEGER,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      summary TEXT NOT NULL,
      next_step TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  await createIndexIfMissing(
    db,
    'dot_internal_cases',
    'ux_dot_internal_cases_action',
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_dot_internal_cases_action ON dot_internal_cases(empresa_id, action_id)',
  );
  await createIndexIfMissing(
    db,
    'dot_internal_cases',
    'idx_dot_internal_cases_empresa_status',
    'CREATE INDEX IF NOT EXISTS idx_dot_internal_cases_empresa_status ON dot_internal_cases(empresa_id, status, updated_at)',
  );

  await createTableIfMissing(
    db,
    'dot_followups',
    `CREATE TABLE IF NOT EXISTS dot_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT NOT NULL,
      decision_id INTEGER NOT NULL,
      action_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      due_at TEXT NOT NULL,
      outcome TEXT,
      baseline_json TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )`,
  );
  await addColumnIfMissing(db, 'dot_followups', 'baseline_json', 'TEXT');
  await addColumnIfMissing(db, 'dot_followups', 'result_json', 'TEXT');
  await createIndexIfMissing(
    db,
    'dot_followups',
    'ux_dot_followups_action',
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_dot_followups_action ON dot_followups(empresa_id, action_id)',
  );
  await createIndexIfMissing(
    db,
    'dot_followups',
    'idx_dot_followups_empresa_status',
    'CREATE INDEX IF NOT EXISTS idx_dot_followups_empresa_status ON dot_followups(empresa_id, status, due_at)',
  );

  await createTableIfMissing(
    db,
    'dot_events',
    `CREATE TABLE IF NOT EXISTS dot_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      source_followup_id INTEGER
    )`,
  );
  await addColumnIfMissing(db, 'dot_events', 'source_followup_id', 'INTEGER');
  await createIndexIfMissing(
    db,
    'dot_events',
    'ux_dot_events_followup',
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_dot_events_followup ON dot_events(empresa_id, source_followup_id)',
  );
  await createIndexIfMissing(
    db,
    'dot_events',
    'idx_dot_events_empresa_type',
    'CREATE INDEX IF NOT EXISTS idx_dot_events_empresa_type ON dot_events(empresa_id, type, created_at)',
  );

  // Propriedade autoritativa usada pela separação de funções (owner override).
  // A tabela nasce vazia: nenhum vínculo é inferido; provisionamento é feito
  // por fluxo administrativo auditado.
  await createTableIfMissing(
    db,
    'empresa_owners',
    `CREATE TABLE IF NOT EXISTS empresa_owners (
      empresa_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provisioned_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
  await createIndexIfMissing(
    db,
    'empresa_owners',
    'idx_empresa_owners_user',
    'CREATE INDEX IF NOT EXISTS idx_empresa_owners_user ON empresa_owners(user_id)',
  );
}

/**
 * Ledger durável do orçamento do Filtra Dot (`services/dotLedger.ts`).
 *
 * A reserva vive no banco porque a versão em memória não sobrevivia a
 * restart nem era vista por outra instância. `ai_usage_id` é único: um
 * consumo real pertence a exatamente uma reserva, o que torna a finalização
 * idempotente também no nível do banco.
 */
async function migrateDotBudgetLedger(db: Database | PgDatabase): Promise<void> {
  db = db as Database;
  await createTableIfMissing(
    db,
    'dot_budget_reservations',
    `CREATE TABLE IF NOT EXISTS dot_budget_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT NOT NULL,
      feature TEXT NOT NULL DEFAULT 'dot',
      plan TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      tokens_reserved INTEGER NOT NULL DEFAULT 0,
      tokens_real INTEGER,
      tokens_estimated INTEGER,
      provider TEXT,
      ambiguous INTEGER NOT NULL DEFAULT 0,
      ambiguous_reason TEXT,
      ai_usage_id INTEGER,
      execution_ref TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      settled_at TEXT
    )`,
  );
  await createIndexIfMissing(
    db,
    'dot_budget_reservations',
    'idx_dot_budget_reservations_empresa',
    'CREATE INDEX IF NOT EXISTS idx_dot_budget_reservations_empresa ON dot_budget_reservations(empresa_id, status, created_at)',
  );
  await createIndexIfMissing(
    db,
    'dot_budget_reservations',
    'idx_dot_budget_reservations_exec',
    'CREATE INDEX IF NOT EXISTS idx_dot_budget_reservations_exec ON dot_budget_reservations(empresa_id, execution_ref)',
  );
  await createIndexIfMissing(
    db,
    'dot_budget_reservations',
    'ux_dot_budget_reservations_ai_usage',
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_dot_budget_reservations_ai_usage ON dot_budget_reservations(ai_usage_id) WHERE ai_usage_id IS NOT NULL',
  );
  // Colunas do consumo por capacidade: bancos anteriores a este ciclo não as têm.
  await addColumnIfMissing(db, 'ai_usage', 'provider', 'TEXT');
  await addColumnIfMissing(db, 'ai_usage', 'feature', 'TEXT');
  await createIndexIfMissing(
    db,
    'ai_usage',
    'idx_ai_usage_feature',
    'CREATE INDEX IF NOT EXISTS idx_ai_usage_feature ON ai_usage(empresa_id, feature, criado_em)',
  );
  // Distinção entre tokens de entrada/saída (o orçamento consome a soma).
  await addColumnIfMissing(db, 'ai_usage', 'tokens_input', 'INTEGER');
  await addColumnIfMissing(db, 'ai_usage', 'tokens_output', 'INTEGER');
  // Marca comprovada de que a solicitação saiu para o provedor: reservas
  // assim não são "abandonadas" pelo sweep (elas precisam de reconciliação).
  await addColumnIfMissing(db, 'dot_budget_reservations', 'sent_at', 'TEXT');
}

/**
 * Registro durável de idempotência HTTP do Filtra Dot.
 * Pending/ambiguous são retidos para impedir reexecução depois de crash;
 * somente respostas concluídas podem expirar pela política de retenção.
 */
async function migrateDotHttpIdempotency(db: Database | PgDatabase): Promise<void> {
  db = db as Database;
  await createTableIfMissing(
    db,
    'dot_http_idempotency',
    `CREATE TABLE IF NOT EXISTS dot_http_idempotency (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      response_status INTEGER,
      response_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      expires_at TEXT NOT NULL
    )`,
  );

  // Fail closed: a table from another schema must never be used with different
  // semantics (a missing column would turn the idempotency guarantee into a
  // best-effort). Reconciliation is explicit and manual.
  const columns = await tableColumns(db, 'dot_http_idempotency');
  const required = [
    'empresa_id',
    'endpoint',
    'idempotency_key',
    'request_hash',
    'status',
    'response_status',
    'response_json',
    'created_at',
    'updated_at',
    'completed_at',
    'expires_at',
  ];
  const missing = required.filter((column) => !columns.includes(column));
  if (missing.length > 0 || columns.includes('tenant_id')) {
    throw new Error(
      `dot_http_idempotency com schema incompatível (faltando: ${missing.join(', ') || 'nenhuma'}; legado tenant_id: ${columns.includes('tenant_id') ? 'sim' : 'não'}). ` +
        'Reconcilie a tabela manualmente antes de iniciar o serviço.',
    );
  }

  await createIndexIfMissing(
    db,
    'dot_http_idempotency',
    'ux_dot_http_idempotency_empresa_key',
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_dot_http_idempotency_empresa_key ON dot_http_idempotency(empresa_id, idempotency_key)',
  );
  await createIndexIfMissing(
    db,
    'dot_http_idempotency',
    'idx_dot_http_idempotency_tenant_status',
    'CREATE INDEX IF NOT EXISTS idx_dot_http_idempotency_tenant_status ON dot_http_idempotency(empresa_id, status, updated_at)',
  );
  await createIndexIfMissing(
    db,
    'dot_http_idempotency',
    'idx_dot_http_idempotency_expiry',
    'CREATE INDEX IF NOT EXISTS idx_dot_http_idempotency_expiry ON dot_http_idempotency(status, expires_at)',
  );
}

/**
 * Sequência central de inicialização. Idempotente.
 * Em PostgreSQL roda inteira sob o advisory lock global, em uma conexão
 * dedicada, garantindo que processos concorrentes não executem DDL ao mesmo
 * tempo.
 */
export async function runCentralMigrations(db: Database | PgDatabase): Promise<void> {
  db = db as Database;
  const execute = async (db: Database | PgDatabase) => {
    db = db as Database;
    await migrateCoreTables(db);
    await migrateReviewsColumns(db);
    await migrateAuthSchema(db);
    await migrateMfaSchema(db);
    await migrateDotActionSchema(db);
    await migrateDotBudgetLedger(db);
    await migrateDotHttpIdempotency(db);
  };

  if (isPgDatabase(db)) {
    await db.withMigrationLock(PG_MIGRATION_LOCK_KEY, (scoped) => execute(scoped as unknown as Database));
    return;
  }

  await execute(db);
}
