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
installCreatorStampHooks(Address, 'company');
installCreatorStampHooks(Tag, 'company');
class Coupon extends Model {}
Coupon.init({ code: DataTypes.STRING, createdById: DataTypes.INTEGER }, { sequelize, modelName: 'Coupon' });
installCreatorStampHooks(Coupon, 'admin');

describe('creator stamp', () => {
  it("a new row made inside a request gets the request's user as creator, whoever creates it", async () => {
    await inRequest(async () => {
      setActor(183, 'company');
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
      setActor(183, 'company');
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
      setActor(5, 'company');
      const tag = Tag.build({ name: 't' });
      await tag.validate();
      expect(tag.get('createdById')).toBeUndefined();
    });
    expect(currentActor()).toBeUndefined();
  });

  it('a company user never becomes the creator of a control table row, an admin never of a company row', async () => {
    await inRequest(async () => {
      setActor(183, 'company');
      const coupon = Coupon.build({ code: 'X' });
      await coupon.validate();
      expect(coupon.get('createdById')).toBeUndefined();
    });
    await inRequest(async () => {
      setActor(9, 'admin');
      const coupon = Coupon.build({ code: 'Y' });
      await coupon.validate();
      expect(coupon.get('createdById')).toBe(9);
      const address = Address.build({ line: 'A' });
      await address.validate();
      expect(address.get('createdById')).toBeUndefined();
    });
  });
});
