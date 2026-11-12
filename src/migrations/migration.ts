import type { QueryInterface, Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';

/** Where a migration runs: the control plane once, or every tenant schema on every shard. */
export type MigrationTarget = 'control' | 'tenant';

/** What a migration receives. Everything runs in `t`, whose `search_path` is `schema`. */
export interface MigrationContext {
  /** Pinned to `schema`: bare table names are qualified for you. Pass `{ transaction: t }` to every call. */
  qi: QueryInterface;
  t: Transaction;
  sequelize: Sequelize;
  /** The schema being migrated (`platform`, `tenant_shared`, `t_42`...). */
  schema: string;
  dbKey: string;
  /** Raw SQL in `t` (DDL or a data fix). */
  sql(statement: string, replacements?: Record<string, unknown>): Promise<unknown>;
}

/**
 * A migration file's default export: `src/migrations/<control|tenant>/<YYYYMMDDHHMMSS>-<name>.ts`.
 * Write it against the database as it was, never through model classes: models describe the
 * latest shape, a migration one step of history.
 */
export interface Migration {
  up(c: MigrationContext): Promise<void>;
  /** Optional: migrations go forward in production; `down` is for undoing a step locally. */
  down?(c: MigrationContext): Promise<void>;
}

/** Typing helper: `export default migration({ async up({ qi, t }) { ... } })`. */
export function migration(definition: Migration): Migration {
  return definition;
}

export interface MigrationFile {
  /** File name without extension: `20261028120000-add-vehicle-color`. */
  name: string;
  path: string;
}
