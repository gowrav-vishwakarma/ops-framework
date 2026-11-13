import { DataTypes, Model, Op, Sequelize } from 'sequelize';
import { describe, expect, it } from 'vitest';
import { missingCompany } from './company-sql.js';
import { pinIncludes } from './model-binding.js';

const shape = { tables: new Set(['Accounts', 'AccountGroups', 'accounts']), columns: new Set(['companyId', 'company_id']) };

describe('raw SQL names the company for every partitioned table', () => {
  it('passes statements that name it once per table', () => {
    for (const sql of [
      `SELECT id FROM "Accounts" WHERE "companyId" = :company`,
      `SELECT a.id FROM "Accounts" a JOIN "AccountGroups" g ON g.id = a."accountGroupId" AND g."companyId" = a."companyId" WHERE a."companyId" = 1`,
      `UPDATE "Accounts" SET name = 'x' WHERE id = 1 AND "companyId" = 1`,
      `INSERT INTO "Accounts" ("companyId", name) VALUES (1, 'x')`,
      `SELECT count(*) FROM tenant_7."Accounts" WHERE "companyId" = 7`,
      `SELECT 1 FROM accounts WHERE company_id = 7`,
      `SELECT 1`,
      `SELECT * FROM "States"`,
    ]) expect(missingCompany(sql, shape), sql).toBeNull();
  });

  it('reports statements that forget it, also for one table of a join', () => {
    expect(missingCompany(`SELECT id FROM "Accounts" WHERE id = 1`, shape)).toEqual(['Accounts']);
    expect(missingCompany(`SELECT a.id FROM "Accounts" a JOIN "AccountGroups" g ON g.id = a."accountGroupId" WHERE a."companyId" = 1`, shape)).toEqual(['Accounts', 'AccountGroups']);
    expect(missingCompany(`DELETE FROM "AccountGroups" WHERE id IN (1, 2)`, shape)).toEqual(['AccountGroups']);
    expect(missingCompany(`SELECT 1 FROM accounts WHERE name = 'company_id'`, shape)).toEqual(['accounts']);
  });
});

describe('joined partitioned models are filtered to the company', () => {
  const sequelize = new Sequelize('postgres://x@localhost/x', { logging: false });
  class Account extends Model {}
  Account.init({ companyId: DataTypes.INTEGER, name: DataTypes.STRING }, { sequelize, modelName: 'Account' });
  class State extends Model {}
  State.init({ name: DataTypes.STRING }, { sequelize, modelName: 'State' });

  it('adds the filter at any depth and keeps an optional join optional', () => {
    const include: Array<Record<string, unknown>> = [
      { model: Account, as: 'party', include: [{ model: Account, as: 'parent', where: { name: 'x' }, required: false }] },
      { model: State, as: 'state' },
    ];
    pinIncludes(include, 7);
    expect(include[0]).toMatchObject({ where: { companyId: 7 }, required: false });
    const inner = (include[0]!.include as Array<Record<string, unknown>>)[0]!;
    expect(inner.where).toEqual({ [Op.and]: [{ name: 'x' }, { companyId: 7 }] });
    expect(inner.required).toBe(false);
    expect(include[1]!.where).toBeUndefined();
  });
});

describe('control-plane tables are not checked', async () => {
  const { installCompanySqlCheck } = await import('./company-sql.js');
  const { runWithTenant } = await import('./context.js');
  const { Sequelize: S, DataTypes: D, Model: M } = await import('sequelize');
  const { NAMES } = await import('../naming.js');

  it('lets a cross-company count of a control table through, still refuses a tenant one', async () => {
    const sequelize = new S('postgres://x@localhost/x', { logging: false });
    class Link extends M {}
    Link.init({ companyId: D.INTEGER, userId: D.INTEGER }, { sequelize, modelName: 'Link', tableName: 'Links', schema: NAMES.controlSchema });
    class Item extends M {}
    Item.init({ companyId: D.INTEGER }, { sequelize, modelName: 'Item', tableName: 'Items' });
    const seen: string[] = [];
    (sequelize as unknown as { query: (sql: string) => Promise<unknown> }).query = async (sql: string) => void seen.push(sql);
    installCompanySqlCheck(sequelize, 'error', () => [Link, Item] as never);
    await runWithTenant({ ref: { companyId: 7 }, placement: { dbKey: 'main', schema: 't7', epoch: 1 }, sequelize } as never, async () => {
      await sequelize.query(`SELECT count(*) FROM "${NAMES.controlSchema}"."Links" WHERE "userId" = 1`);
      await expect(sequelize.query('SELECT count(*) FROM "Items" WHERE id = 1')).rejects.toThrow(/Items/);
    });
    expect(seen).toEqual([`SELECT count(*) FROM "${NAMES.controlSchema}"."Links" WHERE "userId" = 1`]);
  });
});

