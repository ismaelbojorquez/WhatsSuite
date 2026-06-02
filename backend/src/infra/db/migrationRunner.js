import { promises as fs } from 'node:fs';
import path from 'node:path';
import pool from './postgres.js';
import logger from '../logging/logger.js';

const migrationsDir = path.resolve(process.cwd(), 'migrations');
const noTransactionDirective = /^\s*--\s*migrate:\s*no-transaction\b/im;
const legacySqlInitBaselineCutoff = '057_contacts.sql';
const partitionedSqlInitBaselineCutoff = '060_chat_messages_partitioned.sql';

const splitSqlStatements = (sql) => {
  const statements = [];
  let current = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag = null;

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      current += char;
      if (char === '\n') inLineComment = false;
      i += 1;
      continue;
    }

    if (inBlockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        inBlockComment = false;
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        current += char;
        i += 1;
      }
      continue;
    }

    if (inSingle) {
      current += char;
      if (char === "'" && next === "'") {
        current += next;
        i += 2;
      } else {
        if (char === "'") inSingle = false;
        i += 1;
      }
      continue;
    }

    if (inDouble) {
      current += char;
      if (char === '"' && next === '"') {
        current += next;
        i += 2;
      } else {
        if (char === '"') inDouble = false;
        i += 1;
      }
      continue;
    }

    if (char === '-' && next === '-') {
      current += char + next;
      inLineComment = true;
      i += 2;
      continue;
    }

    if (char === '/' && next === '*') {
      current += char + next;
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (char === "'") {
      current += char;
      inSingle = true;
      i += 1;
      continue;
    }

    if (char === '"') {
      current += char;
      inDouble = true;
      i += 1;
      continue;
    }

    if (char === '$') {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }

    if (char === ';') {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      i += 1;
      continue;
    }

    current += char;
    i += 1;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
};

const describeSqlStatement = (statement) => {
  const firstSqlLine = statement
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('--'));
  return (firstSqlLine || 'SQL statement').replace(/\s+/g, ' ').slice(0, 160);
};

const ensureMigrationsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

const listMigrationFiles = async () => {
  try {
    const entries = await fs.readdir(migrationsDir);
    return entries.filter((f) => f.endsWith('.sql')).sort();
  } catch (err) {
    logger.error({ err, migrationsDir }, 'No se pudo leer el directorio de migraciones');
    throw err;
  }
};

const listAppliedMigrations = async () => {
  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  return new Set(rows.map((r) => r.name));
};

const baselineLegacySqlInit = async (files, applied) => {
  if (applied.size > 0) return applied;

  const { rows } = await pool.query(`
    SELECT
      to_regclass('public.chat_messages') IS NOT NULL AS has_chat_messages,
      to_regclass('public.messages_core') IS NOT NULL AS has_messages_core,
      to_regclass('public.audit_logs') IS NOT NULL AS has_audit_logs,
      to_regclass('public.broadcast_messages') IS NOT NULL AS has_broadcast_messages,
      to_regclass('public.contacts') IS NOT NULL AS has_contacts,
      to_regclass('public.chat_message_dedupe_keys') IS NOT NULL AS has_chat_message_dedupe,
      EXISTS (
        SELECT 1
        FROM pg_partitioned_table
        WHERE partrelid = to_regclass('public.chat_messages')
      ) AS has_partitioned_chat_messages
  `);
  const state = rows[0] || {};
  const wasInitializedBySqlEntrypoint =
    state.has_chat_messages &&
    state.has_messages_core &&
    state.has_audit_logs &&
    state.has_broadcast_messages &&
    state.has_contacts;

  if (!wasInitializedBySqlEntrypoint) return applied;

  const cutoff =
    state.has_chat_message_dedupe && state.has_partitioned_chat_messages
      ? partitionedSqlInitBaselineCutoff
      : legacySqlInitBaselineCutoff;
  const legacyFiles = files.filter((file) => file <= cutoff);
  if (!legacyFiles.length) return applied;

  await pool.query(
    'INSERT INTO schema_migrations (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING',
    [legacyFiles]
  );
  logger.warn(
    { count: legacyFiles.length, cutoff },
    'Base inicializada por SQL directo detectada; migraciones legacy marcadas como aplicadas'
  );
  return new Set(legacyFiles);
};

const runPartitionMaintenance = async () => {
  await pool.query(`
    DO $$
    BEGIN
      IF to_regprocedure('ensure_database_partitions(integer, integer)') IS NOT NULL THEN
        PERFORM ensure_database_partitions(2, 12);
      END IF;
    END $$;
  `);
};

const applyMigration = async (file) => {
  const client = await pool.connect();
  const fullPath = path.join(migrationsDir, file);
  const sql = await fs.readFile(fullPath, 'utf8');
  const runWithoutTransaction = noTransactionDirective.test(sql);
  const markApplied = async () => {
    await pool.query('INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [file]);
    logger.warn({ migration: file }, 'Marcada como aplicada por duplicado detectado');
  };
  let inTransaction = false;
  try {
    logger.info({ migration: file, transaction: !runWithoutTransaction }, 'Aplicando migración');
    if (runWithoutTransaction) {
      const statements = splitSqlStatements(sql);
      logger.info({ migration: file, statements: statements.length }, 'Migración sin transacción dividida en sentencias');
      for (const [index, statement] of statements.entries()) {
        const statementNumber = index + 1;
        const statementPreview = describeSqlStatement(statement);
        logger.info(
          { migration: file, statement: statementNumber, statements: statements.length, statementPreview },
          'Ejecutando sentencia de migración'
        );
        await client.query(statement);
        logger.info(
          { migration: file, statement: statementNumber, statements: statements.length },
          'Sentencia de migración aplicada'
        );
      }
    } else {
      await client.query('BEGIN');
      inTransaction = true;
      await client.query(sql);
    }
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    if (inTransaction) {
      await client.query('COMMIT');
      inTransaction = false;
    }
    logger.info({ migration: file, transaction: !runWithoutTransaction }, 'Migración aplicada');
  } catch (err) {
    if (inTransaction) {
      await client.query('ROLLBACK');
      inTransaction = false;
    }
    const duplicateCodes = new Set(['42710', '42P07', '42701', '23505']); // objeto/tabla/columna ya existe, unique violation
    const isDuplicate =
      duplicateCodes.has(err?.code) ||
      /already exists/i.test(err?.message || '') ||
      /duplicate/i.test(err?.message || '');
    if (isDuplicate) {
      logger.warn({ err, migration: file }, 'Migración ya aplicada anteriormente; marcando como completada');
      await markApplied();
      return;
    }
    // Una dependencia faltante indica una base incompleta; no debe ocultarse como aplicada.
    const missingPrereq = /does not exist|missing column|missing relation/i.test(err?.message || '') || err?.code === '42703';
    if (missingPrereq) {
      logger.error({ err, migration: file }, 'Migración con dependencias previas faltantes');
      throw err;
    }
    logger.error({ err, migration: file }, 'Error aplicando migración');
    throw err;
  } finally {
    client.release();
  }
};

export const runPendingMigrations = async () => {
  await ensureMigrationsTable();
  const files = await listMigrationFiles();
  const applied = await baselineLegacySqlInit(files, await listAppliedMigrations());
  const pending = files.filter((f) => !applied.has(f));
  if (!pending.length) {
    await runPartitionMaintenance();
    logger.info({ migrations: files.length }, 'Sin migraciones pendientes');
    return { applied: 0 };
  }
  logger.info({ pending: pending.length, migrations: pending }, 'Migraciones pendientes detectadas');
  for (const file of pending) {
    await applyMigration(file);
  }
  await runPartitionMaintenance();
  return { applied: pending.length };
};

export default runPendingMigrations;
