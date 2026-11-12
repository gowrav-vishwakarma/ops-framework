import { Sequelize } from 'sequelize-typescript';
import { describe, expect, it } from 'vitest';
import { installDdlGuard } from './guards.js';

describe('DDL guard (schema owned by another system)', () => {
  const guarded = () => {
    const sequelize = new Sequelize({ dialect: 'postgres', logging: false });
    installDdlGuard(sequelize, 'primary');
    return sequelize;
  };

  it('refuses schema changes before they reach the database, in any spelling', async () => {
    const sequelize = guarded();
    for (const sql of ['ALTER TABLE x ADD COLUMN y int', '  drop table x', '/* c */ CREATE TABLE x (id int)', 'truncate x', 'CREATE INDEX i ON x(y)', "comment on table x is 'y'", 'GRANT ALL ON x TO y']) {
      await expect(sequelize.query(sql)).rejects.toThrow(/Refused a schema change on "primary"/);
    }
    await expect(sequelize.query({ query: 'ALTER TABLE x DROP COLUMN y', values: [] } as never)).rejects.toThrow(/Refused/);
    await expect(sequelize.sync({ alter: true })).rejects.toThrow(/Refused/);
  });

  it('lets reads and writes through (they fail here only for want of a database)', async () => {
    const sequelize = guarded();
    await expect(sequelize.query('SELECT 1')).rejects.not.toThrow(/Refused/);
    await expect(sequelize.query('UPDATE x SET created = 1')).rejects.not.toThrow(/Refused/);
  });
});
