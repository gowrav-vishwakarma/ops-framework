import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sequelize } from 'sequelize-typescript';
import { currentTenant } from '../tenancy/context.js';

/** Statements worth a plan; transaction control, `SET` and the like are not captured. */
const PLANNED = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;

/** The query's shape: literals and placeholders out, so one query with other values is the same file. */
export function queryShape(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\$\d+/g, '?')
    .replace(/(?<![\w"$])-?\d+(\.\d+)?(?![\w"])/g, '?')
    .replace(/\(\s*\?(\s*,\s*\?)*\s*\)/g, '(?...)')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `logging.queryCapture`: every distinct statement a pool runs is saved once per schema, as
 * `<dir>/<schema>/<hash>.json` (`sql` as run with its `bind` / `replacements`, the `shape` it is
 * known by, the pool). A script can then `EXPLAIN` each in every schema (Ankpal:
 * `npm run queries:explain`). For development and test servers.
 */
export function installQueryCapture(sequelize: Sequelize, dbKey: string, dir: string): void {
  const seen = new Set<string>();
  const target = sequelize as unknown as { query: (sql: unknown, options?: unknown) => Promise<unknown> };
  const query = target.query.bind(sequelize);
  target.query = (sql: unknown, options?: unknown) => {
    try {
      const text = typeof sql === 'string' ? sql : ((sql as { query?: string } | null)?.query ?? '');
      if (PLANNED.test(text)) {
        const schema = currentTenant()?.placement.schema ?? '_no_tenant';
        const shape = queryShape(text);
        const hash = createHash('sha1').update(shape).digest('hex').slice(0, 16);
        if (!seen.has(`${schema}/${hash}`)) {
          seen.add(`${schema}/${hash}`);
          // Model writes pass the statement as `{ query, bind }`; raw queries pass `options.bind`.
          const opts = (options ?? {}) as { bind?: unknown; replacements?: unknown };
          const bind = opts.bind ?? (sql as { bind?: unknown } | null)?.bind ?? null;
          mkdirSync(join(dir, schema), { recursive: true });
          const record = { dbKey, schema, shape, sql: text, bind, replacements: opts.replacements ?? null, capturedAt: new Date().toISOString() };
          // `wx`: another process (or an earlier run) already saved it.
          writeFileSync(join(dir, schema, `${hash}.json`), JSON.stringify(record, null, 1), { flag: 'wx' });
        }
      }
    } catch {
      // Capture never fails a query (an existing file, a full disk).
    }
    return query(sql, options);
  };
}
