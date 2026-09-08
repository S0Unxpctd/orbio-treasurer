#!/usr/bin/env tsx
/**
 * Generates Postgres and SQLite DDL from `packages/core/src/ledger/schema.ts` (T-002, ADR-002).
 *
 * Outputs (all committed, never hand-edited):
 *   supabase/migrations/001_schema.sql
 *   supabase/migrations/002_rls.sql
 *   supabase/migrations/003_append_only.sql
 *   supabase/migrations/004_cron.sql        (static content — no schema dependency, generated
 *                                             here anyway so all migrations have one source of truth)
 *   packages/core/src/ledger/sqlite/schema.sql
 *
 * Run: pnpm --filter @orbio-treasurer/core gen:sql
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ColumnDef, ColumnType, TableDef } from '../src/ledger/schema.js';
import { LEDGER_SCHEMA } from '../src/ledger/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const MIGRATIONS_DIR = resolve(REPO_ROOT, 'supabase/migrations');
const SQLITE_SCHEMA_PATH = resolve(HERE, '../src/ledger/sqlite/schema.sql');

const GENERATED_HEADER = (title: string) =>
  `-- GENERATED FILE — do not hand-edit.
-- Source: packages/core/src/ledger/schema.ts
-- Regenerate: pnpm --filter @orbio-treasurer/core gen:sql
-- ${title}`;

function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function quoteColumns(columns: readonly string[]): string {
  return columns.map((c) => c.trim()).join(', ');
}

function indexName(table: string, columns: readonly string[]): string {
  const slug = columns.map((c) => c.replace(/\s+desc$/i, '_desc').replace(/\s+/g, '_')).join('_');
  return `idx_${table}_${slug}`;
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

const PG_TYPE: Record<ColumnType, string> = {
  uuid: 'uuid',
  text: 'text',
  int: 'integer',
  boolean: 'boolean',
  timestamp: 'timestamptz',
  jsonb: 'jsonb',
  money: 'numeric(18,6)',
  token_amount: 'numeric(30,0)',
};

function pgColumnSql(col: ColumnDef): string {
  const parts = [col.name, PG_TYPE[col.type]];
  if (col.notNull) parts.push('not null');
  if (col.unique) parts.push('unique');
  if (col.default) {
    parts.push(
      col.default.kind === 'bool'
        ? `default ${col.default.value}`
        : `default '${escapeLiteral(col.default.value)}'`,
    );
  }
  if (col.check) parts.push(`check (${col.check})`);
  if (col.references) parts.push(`references ${col.references.table}(id)`);
  return parts.join(' ');
}

function pgTableSql(table: TableDef): string {
  const lines = [
    `-- ${table.comment}`,
    `create table if not exists ${table.name} (`,
    '  id uuid primary key default gen_random_uuid(),',
    ...table.columns.map((c) => `  ${pgColumnSql(c)},`),
    '  created_at timestamptz not null default now()',
    ');',
  ];
  for (const idx of table.indexes ?? []) {
    lines.push(
      `create index if not exists ${indexName(table.name, idx.columns)} on ${table.name} (${quoteColumns(idx.columns)});`,
    );
  }
  return lines.join('\n');
}

function generate001Schema(): string {
  const parts = [
    `${GENERATED_HEADER('Table definitions (Postgres / Supabase).')}\n\n` +
      '-- gen_random_uuid() lives in pgcrypto; Supabase ships it enabled, but this is idempotent.\n' +
      'create extension if not exists pgcrypto;',
    ...LEDGER_SCHEMA.map((t) => pgTableSql(t)),
  ];
  return `${parts.join('\n\n')}\n`;
}

function generate002Rls(): string {
  const lines: string[] = [
    GENERATED_HEADER(
      'Row Level Security: anon may SELECT public rows only. service_role bypasses RLS\n' +
        '-- (Supabase grants service_role the BYPASSRLS attribute by default — no policy needed for it).',
    ),
    '',
  ];
  for (const table of LEDGER_SCHEMA) {
    lines.push(`alter table ${table.name} enable row level security;`);
    switch (table.rls.kind) {
      case 'own-public-column':
        lines.push(
          `create policy ${table.name}_anon_select on ${table.name} for select to anon using (public = true);`,
          `grant select on ${table.name} to anon;`,
        );
        break;
      case 'via-agent-public':
        lines.push(
          `create policy ${table.name}_anon_select on ${table.name} for select to anon using (\n` +
            `  exists (select 1 from agents a where a.id = ${table.name}.agent_id and a.public = true)\n` +
            ');',
          `grant select on ${table.name} to anon;`,
        );
        break;
      case 'all':
        lines.push(
          `-- ${table.name} has no agent_id (global, not per-agent) — see schema.ts RlsPolicy doc.`,
          `create policy ${table.name}_anon_select on ${table.name} for select to anon using (true);`,
          `grant select on ${table.name} to anon;`,
        );
        break;
      case 'none':
        lines.push(
          `-- ${table.name}: no anon policy — anon has no read access (RLS default-denies).`,
        );
        break;
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function pgImmutableCheck(table: TableDef, mutableColumns: readonly string[]): string {
  const immutable = [
    'id',
    ...table.columns.map((c) => c.name).filter((n) => !mutableColumns.includes(n)),
    ...(mutableColumns.includes('created_at') ? [] : ['created_at']),
  ];
  return immutable.map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`).join('\n       OR ');
}

function generate003AppendOnly(): string {
  const lines: string[] = [
    GENERATED_HEADER('Triggers enforcing append-only / mutable-column-guard write policies.'),
    'create or replace function ledger_reject_write() returns trigger as $$',
    'begin',
    "  raise exception '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;",
    'end;',
    '$$ language plpgsql;',
    '',
  ];

  for (const table of LEDGER_SCHEMA) {
    if (table.writePolicy.kind === 'append-only') {
      lines.push(
        `create trigger trg_${table.name}_append_only`,
        `before update or delete on ${table.name}`,
        `for each row execute function ledger_reject_write();`,
        '',
      );
    } else if (table.writePolicy.kind === 'mutable-guard') {
      const { mutableColumns } = table.writePolicy;
      lines.push(
        `create or replace function ${table.name}_guard_write() returns trigger as $$`,
        'begin',
        "  if TG_OP = 'DELETE' then",
        `    raise exception '${table.name} rows cannot be deleted';`,
        '  end if;',
        "  if TG_OP = 'UPDATE' then",
        `    if ${pgImmutableCheck(table, mutableColumns)}`,
        '    then',
        `      raise exception '${table.name}: only ${mutableColumns.join(', ')} may be updated';`,
        '    end if;',
        '  end if;',
        '  return NEW;',
        'end;',
        '$$ language plpgsql;',
        '',
        `create trigger trg_${table.name}_guard`,
        `before update or delete on ${table.name}`,
        `for each row execute function ${table.name}_guard_write();`,
        '',
      );
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function generate004Cron(): string {
  return `${GENERATED_HEADER(
    'Hosted-reference tick schedule (FR-10.1, ARCHITECTURE §7, probe P-8).\n' +
      '-- app.tick_url and app.cron_secret are Postgres settings, set by docs/runbook.md via\n' +
      "-- 'alter database ... set app.tick_url = ...' (or per-session in the Supabase dashboard).\n" +
      '-- They are NEVER hard-coded in this file.',
  )}\n\ncreate extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'treasurer-tick',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := current_setting('app.tick_url'),
    headers := jsonb_build_object(
      'x-cron-secret', current_setting('app.cron_secret'),
      'content-type', 'application/json'
    ),
    body := '{}'::jsonb
  )
  $$
);
`;
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

const SQLITE_TYPE: Record<ColumnType, string> = {
  uuid: 'TEXT',
  text: 'TEXT',
  int: 'INTEGER',
  boolean: 'INTEGER',
  timestamp: 'TEXT',
  jsonb: 'TEXT',
  money: 'TEXT',
  token_amount: 'TEXT',
};

function sqliteColumnSql(col: ColumnDef): string {
  const parts = [col.name, SQLITE_TYPE[col.type]];
  if (col.notNull) parts.push('NOT NULL');
  if (col.unique) parts.push('UNIQUE');
  if (col.default) {
    parts.push(
      col.default.kind === 'bool'
        ? `DEFAULT ${col.default.value ? 1 : 0}`
        : `DEFAULT '${escapeLiteral(col.default.value)}'`,
    );
  }
  const checks: string[] = [];
  if (col.type === 'boolean') checks.push(`${col.name} in (0,1)`);
  if (col.check) checks.push(col.check);
  for (const c of checks) parts.push(`CHECK (${c})`);
  if (col.references) parts.push(`REFERENCES ${col.references.table}(id)`);
  return parts.join(' ');
}

function sqliteTableSql(table: TableDef): string {
  const lines = [
    `-- ${table.comment}`,
    `CREATE TABLE IF NOT EXISTS ${table.name} (`,
    '  id TEXT PRIMARY KEY NOT NULL,',
    ...table.columns.map((c) => `  ${sqliteColumnSql(c)},`),
    "  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    ');',
  ];
  for (const idx of table.indexes ?? []) {
    lines.push(
      `CREATE INDEX IF NOT EXISTS ${indexName(table.name, idx.columns)} ON ${table.name} (${quoteColumns(
        idx.columns.map((c) => c.replace(/\s+desc$/i, ' DESC')),
      )});`,
    );
  }
  return lines.join('\n');
}

function sqliteImmutableCheck(table: TableDef, mutableColumns: readonly string[]): string {
  const immutable = [
    'id',
    ...table.columns.map((c) => c.name).filter((n) => !mutableColumns.includes(n)),
    ...(mutableColumns.includes('created_at') ? [] : ['created_at']),
  ];
  return immutable.map((c) => `NEW.${c} IS NOT OLD.${c}`).join('\n    OR ');
}

function generateSqliteSchema(): string {
  const lines: string[] = [
    GENERATED_HEADER(
      'Single-file ledger schema for kit agents (ADR-002). Money and token amounts are TEXT\n' +
        '-- decimal strings, never REAL — see schema.ts. Foreign keys are declared but SQLite only\n' +
        '-- enforces them when the connection runs `PRAGMA foreign_keys = ON;` (per-connection,\n' +
        '-- not persisted in this file — the repository layer, T-011, must set it on open).',
    ),
    ...LEDGER_SCHEMA.map((t) => sqliteTableSql(t)),
    '',
    '-- Append-only / mutable-column-guard triggers.',
    '',
  ];

  for (const table of LEDGER_SCHEMA) {
    if (table.writePolicy.kind === 'append-only') {
      lines.push(
        `CREATE TRIGGER IF NOT EXISTS trg_${table.name}_no_update`,
        `BEFORE UPDATE ON ${table.name}`,
        'BEGIN',
        `  SELECT RAISE(ABORT, '${table.name} is append-only: UPDATE is not permitted');`,
        'END;',
        '',
        `CREATE TRIGGER IF NOT EXISTS trg_${table.name}_no_delete`,
        `BEFORE DELETE ON ${table.name}`,
        'BEGIN',
        `  SELECT RAISE(ABORT, '${table.name} is append-only: DELETE is not permitted');`,
        'END;',
        '',
      );
    } else if (table.writePolicy.kind === 'mutable-guard') {
      const { mutableColumns } = table.writePolicy;
      lines.push(
        `CREATE TRIGGER IF NOT EXISTS trg_${table.name}_no_delete`,
        `BEFORE DELETE ON ${table.name}`,
        'BEGIN',
        `  SELECT RAISE(ABORT, '${table.name} rows cannot be deleted');`,
        'END;',
        '',
        `CREATE TRIGGER IF NOT EXISTS trg_${table.name}_guard_update`,
        `BEFORE UPDATE ON ${table.name}`,
        `WHEN (`,
        `    ${sqliteImmutableCheck(table, mutableColumns)}`,
        ')',
        'BEGIN',
        `  SELECT RAISE(ABORT, '${table.name}: only ${mutableColumns.join(', ')} may be updated');`,
        'END;',
        '',
      );
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

mkdirSync(MIGRATIONS_DIR, { recursive: true });
mkdirSync(dirname(SQLITE_SCHEMA_PATH), { recursive: true });

const files: Record<string, string> = {
  [resolve(MIGRATIONS_DIR, '001_schema.sql')]: generate001Schema(),
  [resolve(MIGRATIONS_DIR, '002_rls.sql')]: generate002Rls(),
  [resolve(MIGRATIONS_DIR, '003_append_only.sql')]: generate003AppendOnly(),
  [resolve(MIGRATIONS_DIR, '004_cron.sql')]: generate004Cron(),
  [SQLITE_SCHEMA_PATH]: generateSqliteSchema(),
};

for (const [path, content] of Object.entries(files)) {
  writeFileSync(path, content, 'utf8');
  console.error(`wrote ${path}`);
}
