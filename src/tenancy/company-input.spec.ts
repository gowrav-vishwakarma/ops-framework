import { describe, expect, it } from 'vitest';
import { checkCompanyInput, CompanyInputPipe, CompanyInputRefused } from './company-input.js';
import { runWithTenant } from './context.js';

const ref = { companyId: 7, tenantKey: 't7' };
const inTenant = <T>(work: () => T) => runWithTenant({ ref, placement: { dbKey: 'main', schema: 't7', epoch: 1 }, sequelize: {} as never } as never, async () => work());

describe('company input: the signed-in company only', () => {
  it('removes the signed-in company wherever it is named', () => {
    const body = { companyId: 7, name: 'x', lines: [{ companyId: '7', qty: 1 }], where: { '$account.companyId$': { $in: [7] }, companyId: null } };
    checkCompanyInput(body, 7, 'body');
    expect(body).toEqual({ name: 'x', lines: [{ qty: 1 }], where: {} });
  });

  it('refuses another company at any depth, in values, lists and operators', () => {
    for (const body of [{ companyId: 8 }, { lines: [{ companyId: 8 }] }, { where: { companyId: { $in: [7, 8] } } }, { include: [{ where: { 'account.companyId': 8 } }] }, { companyId: ' 9 ' }]) {
      expect(() => checkCompanyInput(body, 7, 'body')).toThrow(CompanyInputRefused);
    }
  });

  it('leaves look-alike fields and files alone', () => {
    const body = { fromCompanyId: 8, companyIds: [8], file: Buffer.from('companyId'), note: 'companyId: 8' };
    checkCompanyInput(body, 7, 'body');
    expect(body.fromCompanyId).toBe(8);
    expect(body.companyIds).toEqual([8]);
  });

  it('does not change what cannot be changed (computed query) but still refuses', () => {
    const query = { companyId: '7' };
    checkCompanyInput(query, 7, 'query', false);
    expect(query).toEqual({ companyId: '7' });
    expect(() => checkCompanyInput({ companyId: '8' }, 7, 'query', false)).toThrow(CompanyInputRefused);
  });

  it('the pipe works only in a tenant context, on body, query and params, and never hands over a named company field', async () => {
    const pipe = new CompanyInputPipe();
    expect(pipe.transform({ companyId: 8 }, { type: 'body' })).toEqual({ companyId: 8 });
    await inTenant(() => {
      expect(() => pipe.transform({ companyId: 8 }, { type: 'body' })).toThrow(CompanyInputRefused);
      expect(pipe.transform({ user: { companyId: 8 } }, { type: 'custom' })).toEqual({ user: { companyId: 8 } });
      expect(pipe.transform('7', { type: 'param', data: 'companyId' })).toBeUndefined();
      expect(() => pipe.transform('8', { type: 'query', data: 'companyId' })).toThrow(CompanyInputRefused);
      expect(pipe.transform({ id: 1, companyId: 7 }, { type: 'query' })).toEqual({ id: 1 });
    });
  });
});
