import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installQueryCapture, queryShape } from './query-capture.js';

describe('query capture', () => {
  it('knows a query by its shape, whatever its values', () => {
    expect(queryShape(`SELECT * FROM "s"."A" WHERE "id" = 7 AND "name" = 'x''y' AND "v" IN (1, 2, 3) LIMIT 10`)).toBe(queryShape(`SELECT * FROM "s"."A" WHERE "id" = 9 AND "name" = 'z' AND "v" IN (4) LIMIT 20`));
    expect(queryShape('UPDATE "s"."A" SET "x"=$1 WHERE "id" = $2')).toBe('UPDATE "s"."A" SET "x"=? WHERE "id" = ?');
  });

  it('saves each distinct statement once, with what it ran with; transaction control is not saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-'));
    const ran: unknown[] = [];
    const fake = { query: async (sql: unknown, _options?: unknown) => ran.push(sql) };
    installQueryCapture(fake as never, 'primary', dir);
    await fake.query('SELECT 1 FROM "t" WHERE id = 1', { bind: [1] } as never);
    await fake.query('SELECT 1 FROM "t" WHERE id = 2');
    await fake.query({ query: 'INSERT INTO "t" ("a") VALUES ($1)', bind: ['v'] });
    await fake.query('SET LOCAL search_path TO "x"');
    await fake.query('START TRANSACTION');
    expect(ran).toHaveLength(5);
    const files = readdirSync(join(dir, '_no_tenant')).sort();
    expect(files).toHaveLength(2);
    const insert = files.map((f) => JSON.parse(readFileSync(join(dir, '_no_tenant', f), 'utf8'))).find((r) => r.sql.startsWith('INSERT'));
    expect(insert.bind).toEqual(['v']);
    expect(files.map((f) => JSON.parse(readFileSync(join(dir, '_no_tenant', f), 'utf8'))).find((r) => r.sql.startsWith('SELECT'))).toMatchObject({ dbKey: 'primary', sql: 'SELECT 1 FROM "t" WHERE id = 1', bind: [1] });
  });
});
