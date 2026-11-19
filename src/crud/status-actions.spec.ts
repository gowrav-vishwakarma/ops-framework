import { describe, expect, it } from 'vitest';
import { payloadProblems } from '../payload/check-payload.js';
import { bulkStatusAction, statusActions, statusInput } from './status-actions.js';

const check = (values: readonly (string | boolean)[], payload: unknown) => payloadProblems(statusInput(values), payload, { endpoint: 'test', mode: 'error' }).errors;

describe('status actions', () => {
  it('activate and deactivate only, unless bulk is asked for', () => {
    expect(statusActions({ noun: 'branch' }).map((a) => a.name)).toEqual(['deactivate', 'activate']);
    const [, , bulk] = statusActions({ noun: 'branch', bulk: true });
    expect(bulk).toMatchObject({ name: 'bulk-status', kind: 'bulk' });
    expect(statusActions({ noun: 'branch', bulk: 'bulkUpdateStatus' })[2]!.name).toBe('bulkUpdateStatus');
  });

  it('a bulk status action over row actions runs activate or deactivate per record, by the status asked for', () => {
    const bulk = statusActions({ noun: 'branch', field: 'state', active: 'on', inactive: 'off', bulk: true })[2]!;
    expect(bulk.each!({ status: 'on' })).toBe('activate');
    expect(bulk.each!({ status: 'off' })).toBe('deactivate');
    expect(bulk.run).toBeUndefined();
    expect(bulk.effect).toBe('each record: activate or deactivate (by status)');
  });

  it('a bulk status action without row actions sets the column itself', () => {
    const bulk = bulkStatusAction({ noun: 'accounts', values: ['active', 'inactive', 'suspended'] });
    expect(bulk.each).toBeUndefined();
    expect(bulk.run).toBeTypeOf('function');
    // One input class per entity: the contract names its schema after it.
    expect(bulk.input!.name).toBe('AccountsStatusInput');
    expect(bulkStatusAction({ noun: 'brand divisions', values: ['active'] }).input!.name).toBe('BrandDivisionsStatusInput');
  });

  it("the input takes the entity's own values only, with no conversion", () => {
    expect(check(['active', 'inActive'], { status: 'inActive' })).toEqual({});
    expect(Object.keys(check(['active', 'inActive'], { status: 'inactive' }))).toEqual(['status']);
    expect(Object.keys(check(['active', 'inActive'], {}))).toEqual(['status']);
    expect(check([true, false], { status: false })).toEqual({});
    expect(Object.keys(check([true, false], { status: 'false' }))).toEqual(['status']);
    expect(Object.keys(check([true, false], { status: true, ids: [1] }))).toEqual(['ids']);
  });
});
