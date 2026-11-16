import { ClsServiceManager } from 'nestjs-cls';
import { DataTypes, Model, Sequelize } from 'sequelize';
import { describe, expect, it } from 'vitest';
import { currentActor, installCreatorStampHooks, setActor } from './actor.js';

const inRequest = <T>(work: () => Promise<T>) => ClsServiceManager.getClsService().run(work);

// No connection is opened: building and validating rows runs the hooks without a database.
const sequelize = new Sequelize('postgres://user@localhost:1/none', { logging: false });
class Address extends Model {}
Address.init({ line: DataTypes.STRING, createdById: DataTypes.INTEGER }, { sequelize, modelName: 'Address' });
class Tag extends Model {}
Tag.init({ name: DataTypes.STRING }, { sequelize, modelName: 'Tag' });
installCreatorStampHooks(Address);
installCreatorStampHooks(Tag);

describe('creator stamp', () => {
  it("a new row made inside a request gets the request's user as creator, whoever creates it", async () => {
    await inRequest(async () => {
      setActor(183);
      const row = Address.build({ line: 'A' });
      await row.validate();
      expect(row.get('createdById')).toBe(183);
      const bulk = [Address.build({ line: 'B' }), Address.build({ line: 'C' })];
      await (Address as unknown as { runHooks(name: string, ...args: unknown[]): Promise<void> }).runHooks('beforeBulkCreate', bulk, {});
      expect(bulk.map((r) => r.get('createdById'))).toEqual([183, 183]);
    });
  });

  it('keeps a creator the code set, and never stamps a row that is not new', async () => {
    await inRequest(async () => {
      setActor(183);
      const own = Address.build({ line: 'A', createdById: 7 });
      await own.validate();
      expect(own.get('createdById')).toBe(7);
      const old = Address.build({ id: 1, line: 'B', createdById: null }, { isNewRecord: false });
      await old.validate();
      expect(old.get('createdById')).toBeNull();
    });
  });

  it('stamps nothing without an actor (a job, a portal or API-key request) and leaves models without the column alone', async () => {
    await inRequest(async () => {
      expect(currentActor()).toBeUndefined();
      const row = Address.build({ line: 'A' });
      await row.validate();
      expect(row.get('createdById')).toBeUndefined();
      setActor(5);
      const tag = Tag.build({ name: 't' });
      await tag.validate();
      expect(tag.get('createdById')).toBeUndefined();
    });
    expect(currentActor()).toBeUndefined();
  });
});
