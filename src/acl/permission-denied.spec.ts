import { describe, expect, it } from 'vitest';
import { humanizeName, permissionDenied, permissionLabel, PERMISSION_DENIED } from './permission-denied.js';

describe('permission refusals in words', () => {
  it('humanizes resource and action names', () => {
    expect(humanizeName('SalesmanCommission')).toBe('salesman commission');
    expect(humanizeName('fuel_entry')).toBe('fuel entry');
    expect(humanizeName('GSTRReport')).toBe('gstr report');
  });

  it('labels a code: catalog label first, then the action words, then the action name', () => {
    const catalog = [{ resource: 'fuel_entry', action: 'approve', code: 'fuel_entry.approve', label: 'Approve fuel entries', groupName: 'Fleet', sortOrder: 0, scopes: [], limits: [] }];
    expect(permissionLabel({ catalog, acl: {} }, 'fuel_entry.approve')).toBe('approve fuel entries');
    expect(permissionLabel(undefined, 'Account.update')).toBe('edit account');
    expect(permissionLabel({ catalog: [], acl: { actionLabels: { page: 'Open' } } }, 'SalesmanCommission.page')).toBe('open salesman commission');
    expect(permissionLabel(undefined, 'Voucher.markPrinted')).toBe('mark printed voucher');
  });

  it('answers 403 with a code, the permission and a sentence naming who can give the right', () => {
    const refusal = permissionDenied(undefined, 'Account.delete');
    expect(refusal.getStatus()).toBe(403);
    expect(refusal.getResponse()).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      code: PERMISSION_DENIED,
      permission: 'Account.delete',
      message: "You don't have permission to delete account. Ask the owner or your administrator to give you this right.",
    });
  });
});
