import { BadRequestException } from '@nestjs/common';
import { DataTypes, Model, Op, Sequelize } from 'sequelize';
import { describe, expect, it } from 'vitest';
import { buildLookupFind, lookupParams, type LookupDef } from './lookup.js';

class Party extends Model {}
class Group extends Model {}
class Phone extends Model {}
const sequelize = new Sequelize('postgres://x@localhost/x', { logging: false });
Group.init({ name: DataTypes.STRING, code: DataTypes.STRING }, { sequelize, modelName: 'Group' });
Party.init({ name: DataTypes.STRING, gstin: DataTypes.STRING, mobile: DataTypes.STRING, groupId: DataTypes.INTEGER, secret: DataTypes.STRING }, { sequelize, modelName: 'Party' });
Party.belongsTo(Group, { as: 'group', foreignKey: 'groupId' });
Phone.init({ number: DataTypes.STRING, partyId: DataTypes.INTEGER }, { sequelize, modelName: 'Phone' });
Party.hasMany(Phone, { as: 'phones', foreignKey: 'partyId' });

const def: LookupDef = { fields: ['name', 'gstin', 'mobile', 'group.name'], search: ['name', 'gstin', 'group.name'], defaultFields: ['name', 'gstin'], defaultSearch: ['name'] };

describe('lookup find', () => {
  it("shows the defaults when the request names no fields, and searches the default search fields", () => {
    const find = buildLookupFind(Party, def, { q: 'sun' });
    expect(find.attributes).toEqual(['id', 'name', 'gstin']);
    expect(find.include).toEqual([]);
    expect(find.where).toEqual([{ [Op.or]: [{ name: { [Op.iLike]: '%sun%' } }] }]);
    expect(find.limit).toBe(20);
    expect(find.order).toEqual([['name', 'ASC']]);
  });

  it("shows the chosen fields, an association's field through its include, and searches any of the chosen fields", () => {
    const find = buildLookupFind(Party, def, { q: 'ab', fields: 'name,group.name', search: 'gstin,group.name' });
    expect(find.attributes).toEqual(['id', 'name', 'gstin']);
    expect(find.include).toEqual([{ association: 'group', attributes: ['id', 'name'], required: false }]);
    expect(find.where).toEqual([{ [Op.or]: [{ gstin: { [Op.iLike]: '%ab%' } }, { '$group.name$': { [Op.iLike]: '%ab%' } }] }]);
  });

  it('refuses a field the lookup does not allow, to show or to search (never silently dropped)', () => {
    expect(() => buildLookupFind(Party, def, { fields: 'name,secret' })).toThrow(BadRequestException);
    expect(() => buildLookupFind(Party, def, { search: 'mobile' })).toThrow('Search fields not allowed in this lookup: mobile');
  });

  it('reads the chosen rows by id (a form opened for editing), and keeps the limit within the lookup cap', () => {
    const find = buildLookupFind(Party, { ...def, maxLimit: 50 }, { ids: '7, 9,x', limit: 500 });
    expect(find.where).toEqual([{ id: { [Op.in]: [7, 9] } }]);
    expect(find.limit).toBe(50);
  });

  it("treats the typed text as text: % and _ match themselves", () => {
    const find = buildLookupFind(Party, def, { q: '50%_off' });
    expect(find.where).toEqual([{ [Op.or]: [{ name: { [Op.iLike]: '%50\\%\\_off%' } }] }]);
  });

  it('refuses a name the model does not have even if a lookup lists it', () => {
    expect(() => buildLookupFind(Party, { fields: ['nope'], search: [] }, {})).toThrow('Unknown field nope');
  });

  it('filters only on the fields the lookup allows: a value, or a list of values; anything else refused', () => {
    const withFilters: LookupDef = { ...def, filters: ['mobile', 'group.code'] };
    expect(buildLookupFind(Party, withFilters, { filters: JSON.stringify({ mobile: '98', 'group.code': ['A', 'B'] }) }).where).toEqual([{ mobile: '98' }, { '$group.code$': { [Op.in]: ['A', 'B'] } }]);
    expect(() => buildLookupFind(Party, withFilters, { filters: JSON.stringify({ name: 'x' }) })).toThrow('Filter not allowed in this lookup: name');
    expect(() => buildLookupFind(Party, withFilters, { filters: JSON.stringify({ mobile: { $ne: 1 } }) })).toThrow('takes a value or a list of values');
    expect(() => buildLookupFind(Party, withFilters, { filters: '[1]' })).toThrow('filters must be a JSON object');
  });

  it("reads the lookup's named parameters, typed; an undeclared key or a bad value is refused", () => {
    const withParams: LookupDef = { ...def, params: { side: 'text', date: 'date', accountId: 'number', purchase: 'boolean', branches: 'ids' } };
    expect(lookupParams(withParams, { q: 'x', side: 'sales', date: '2026-11-15', accountId: '7', purchase: 'false', branches: '1,2', limit: '5' })).toEqual({ side: 'sales', date: '2026-11-15', accountId: 7, purchase: false, branches: [1, 2] });
    expect(() => lookupParams(withParams, { other: '1' })).toThrow('Unknown lookup parameter: other');
    expect(() => lookupParams(withParams, { date: '15/11/2026' })).toThrow('date must be a date');
    expect(() => lookupParams(withParams, { accountId: 'abc' })).toThrow('accountId must be a number');
  });

  it("adds the lookup's own conditions to every request (never the request's to drop)", () => {
    const find = buildLookupFind(Party, { ...def, where: { mobile: { [Op.ne]: null } } }, { q: 'x' });
    expect(find.where[0]).toEqual({ mobile: { [Op.ne]: null } });
    expect(find.where).toHaveLength(2);
  });

  it('reads a to-many association as its own query (one row per record, the limit holds); it cannot be searched or filtered', () => {
    const many: LookupDef = { fields: ['name', 'phones.number'], search: ['name', 'phones.number'], defaultSearch: ['name'], filters: ['phones.number'] };
    expect(buildLookupFind(Party, many, { fields: 'name,phones.number' }).include).toEqual([{ association: 'phones', attributes: ['id', 'number', 'partyId'], separate: true }]);
    expect(() => buildLookupFind(Party, many, { q: 'x', search: 'phones.number' })).toThrow('cannot be searched or filtered');
    expect(() => buildLookupFind(Party, many, { filters: '{"phones.number":"1"}' })).toThrow('cannot be searched or filtered');
  });

  it('leaves the search to the steps when the lookup says so: its names are its own and q is not applied', () => {
    const own: LookupDef = { fields: ['name'], search: ['name', 'alias'], searchSteps: true };
    const find = buildLookupFind(Party, own, { q: 'sun', search: 'alias' });
    expect(find.where).toEqual([]);
    expect(find.search).toEqual({ q: 'sun', fields: ['alias'] });
  });
});
