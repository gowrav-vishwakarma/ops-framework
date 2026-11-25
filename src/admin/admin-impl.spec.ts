import { describe, expect, it } from 'vitest';
import type { Provider } from '@nestjs/common';
import { adminProviders } from '../framework.module.js';
import { ADMIN_ACL_SOURCE, ADMIN_TOKEN_VALIDATOR, CONTROL_AUDIT_SINK, type AdminAclSource, type AdminTokenValidator, type ControlAuditSink } from '../features.js';
import { AdminAclService } from './admin-acl.service.js';
import { AdminCatalogService } from './admin-catalog.service.js';
import { TableAdminAclSource } from './table-admin-acl.source.js';
import { TableControlAuditSink } from './table-control-audit.sink.js';
import type { AdminUser } from '../auth/auth-user.js';

class OwnAcl implements AdminAclSource {
  load = () => Promise.resolve(new Map());
}
class OwnAudit implements ControlAuditSink {
  record = () => Promise.resolve();
  history = () => Promise.resolve([]);
}
class OwnValidator implements AdminTokenValidator {
  validate = () => Promise.resolve();
}

const bound = (providers: Provider[], token: symbol) =>
  (providers.find((p) => typeof p === 'object' && 'provide' in p && p.provide === token) as { useExisting: unknown } | undefined)?.useExisting;

describe('features.admin', () => {
  it('off: no admin providers', () => {
    expect(adminProviders({ schema: 'external' })).toEqual([]);
  });

  it("'tables' / true: the framework's tables, with the catalog sync", () => {
    for (const admin of [true, 'tables'] as const) {
      const providers = adminProviders({ schema: 'owned', admin });
      expect(bound(providers, ADMIN_ACL_SOURCE)).toBe(TableAdminAclSource);
      expect(bound(providers, CONTROL_AUDIT_SINK)).toBe(TableControlAuditSink);
      expect(providers).toContain(AdminCatalogService);
    }
  });

  it("the project's own source and audit: no framework admin table, no catalog sync", () => {
    const providers = adminProviders({ schema: 'external', admin: { acl: OwnAcl, audit: OwnAudit } });
    expect(bound(providers, ADMIN_ACL_SOURCE)).toBe(OwnAcl);
    expect(bound(providers, CONTROL_AUDIT_SINK)).toBe(OwnAudit);
    expect(providers).toContain(AdminAclService);
    expect(providers).not.toContain(AdminCatalogService);
    expect(providers).not.toContain(TableAdminAclSource);
  });

  it("only a tokenValidator: the framework's tables plus the project's admin token check", () => {
    const providers = adminProviders({ schema: 'owned', admin: { tokenValidator: OwnValidator } });
    expect(bound(providers, ADMIN_ACL_SOURCE)).toBe(TableAdminAclSource);
    expect(bound(providers, CONTROL_AUDIT_SINK)).toBe(TableControlAuditSink);
    expect(bound(providers, ADMIN_TOKEN_VALIDATOR)).toBe(OwnValidator);
    expect(providers).toContain(AdminCatalogService);
  });

  it('the project tables keep their tokenValidator; without one none is bound', () => {
    expect(bound(adminProviders({ schema: 'external', admin: { acl: OwnAcl, audit: OwnAudit, tokenValidator: OwnValidator } }), ADMIN_TOKEN_VALIDATOR)).toBe(OwnValidator);
    expect(bound(adminProviders({ schema: 'owned', admin: true }), ADMIN_TOKEN_VALIDATOR)).toBeUndefined();
  });

  it('acl without audit (or the reverse) is refused', () => {
    expect(() => adminProviders({ schema: 'external', admin: { acl: OwnAcl } })).toThrow('give both acl and audit');
  });

  it('AdminAclService asks the source once a minute per admin', async () => {
    let calls = 0;
    const source: AdminAclSource = { load: () => { calls++; return Promise.resolve(new Map([['License.create', { scope: 'all' as const, limits: {} }]])); } };
    const acl = new AdminAclService(source);
    const admin = { id: 7, roleId: null, aclVersion: 0 } as unknown as AdminUser;
    expect((await acl.effective(admin)).get('License.create')?.scope).toBe('all');
    await acl.effective(admin);
    expect(calls).toBe(1);
  });
});
