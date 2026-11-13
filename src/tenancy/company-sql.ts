import { InternalServerErrorException, Logger } from '@nestjs/common';
import type { Model, ModelStatic, Sequelize } from 'sequelize';
import { currentTenant } from './context.js';
import { PARTITION, partitionColumnOf } from './partition.js';

/**
 * `tenancy.companySql`: raw SQL in a tenant context must name the company for every partitioned
 * table it reads or writes. Model calls are filtered by the partition hooks; raw SQL (`c.sql`,
 * `c.count`, `sequelize.query`) is only as safe as its author. A statement that refers to more
 * partitioned tables than it mentions the partition column is refused (`error`: tests and scenario
 * runs) or reported (`warn`). `off` (the default) skips it: production pays nothing per query.
 *
 * A heuristic on the text, deliberately strict: `FROM "Accounts" a JOIN "AccountGroups" g ON g.id =
 * a."accountGroupId" WHERE a."companyId" = :company` names the company once for two tables and is
 * reported; add `AND g."companyId" = :company` (rows classic wrote across companies stay out).
 */
export type CompanySqlCheck = 'off' | 'warn' | 'error';

export class CompanySqlRefused extends InternalServerErrorException {
  constructor(sql: string, tables: string[]) {
    super(`Raw SQL does not name the company for every partitioned table (${tables.join(', ')}): ${sql.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}

interface Shape {
  /** Partitioned table names, as written in SQL. */
  tables: Set<string>;
  /** Partition column names. */
  columns: Set<string>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function shapeOf(models: ModelStatic<Model>[]): Shape {
  const tables = new Set<string>();
  const columns = new Set<string>([PARTITION.column]);
  for (const model of models) {
    if (!(PARTITION.field in model.getAttributes()) || PARTITION.exempt.includes(model.name)) continue;
    const name = model.getTableName() as string | { tableName: string };
    tables.add(typeof name === 'string' ? name : name.tableName);
    columns.add(partitionColumnOf(model as never));
  }
  return { tables, columns };
}

/** The partitioned tables a statement refers to (FROM / JOIN / UPDATE / INTO / DELETE FROM), with repeats. */
export function partitionedReferences(sql: string, tables: Set<string>): string[] {
  const found: string[] = [];
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:"?[A-Za-z_][\w]*"?\s*\.\s*)?("([^"]+)"|([A-Za-z_][\w]*))/gi;
  for (const m of sql.matchAll(re)) {
    const name = m[2] ?? m[3]!;
    if (tables.has(name)) found.push(name);
  }
  return found;
}

/** How often a statement mentions the partition column (`"companyId"`, `a."companyId"`, `company_id`). */
export function partitionMentions(sql: string, columns: Set<string>): number {
  let n = 0;
  for (const column of columns) {
    const quoted = sql.match(new RegExp(`"${escape(column)}"`, 'g'))?.length ?? 0;
    // Unquoted only when the column is a plain lower-case identifier (snake_case schemas).
    const bare = /^[a-z_][a-z0-9_]*$/.test(column) ? (sql.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '').match(new RegExp(`\\b${escape(column)}\\b`, 'g'))?.length ?? 0) : 0;
    n += quoted + bare;
  }
  return n;
}

/** Whether `sql` names the company at least once per partitioned table it refers to; the tables when not. */
export function missingCompany(sql: string, shape: Shape): string[] | null {
  const refs = partitionedReferences(sql, shape.tables);
  if (!refs.length) return null;
  return partitionMentions(sql, shape.columns) >= refs.length ? null : [...new Set(refs)];
}

export function installCompanySqlCheck(sequelize: Sequelize, mode: CompanySqlCheck, models: () => ModelStatic<Model>[]): void {
  if (mode === 'off') return;
  const logger = new Logger('CompanySql');
  let shape: Shape | null = null;
  const warned = new Set<string>();
  const target = sequelize as unknown as { query: (sql: unknown, options?: Record<string, unknown>) => Promise<unknown> };
  const query = target.query.bind(sequelize);
  target.query = (sql: unknown, options?: Record<string, unknown>) => {
    // Model calls (they carry their model or instance) are filtered by the partition hooks.
    if (currentTenant() && !options?.model && !options?.instance) {
      const text = typeof sql === 'string' ? sql : ((sql as { query?: string } | null)?.query ?? '');
      shape ??= shapeOf(models());
      const missing = missingCompany(text, shape);
      if (missing) {
        if (mode === 'error') return Promise.reject(new CompanySqlRefused(text, missing));
        if (!warned.has(text)) {
          warned.add(text);
          logger.warn(new CompanySqlRefused(text, missing).message);
        }
      }
    }
    return query(sql, options);
  };
}
