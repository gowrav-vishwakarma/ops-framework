import { describe, expect, it } from 'vitest';
import { TenantCrudService } from './tenant-crud.service.js';

/** Exposes the protected mapping the create and update paths use. */
abstract class Probe extends TenantCrudService<never, object> {
  static strip(dto: object) {
    return (Probe.prototype as unknown as { withoutSystemFields(dto: object): Record<string, unknown> }).withoutSystemFields.call({}, dto);
  }
}

describe('TenantCrudService system fields', () => {
  it('drops an injected id and partition: a request cannot move a row to another company', () => {
    const out = Probe.strip({ name: 'Legit Party', companyId: 999, id: 12345 });
    expect(out).toEqual({ name: 'Legit Party' });
  });

  it('drops injected created/updated by, in both spellings', () => {
    const out = Probe.strip({ remarks: 'x', createdById: 1, updatedById: 1, created_by_id: 1, updated_by_id: 1 });
    expect(out).toEqual({ remarks: 'x' });
  });

  it('keeps every other field and does not change the input', () => {
    const dto = { name: 'A', amount: 10, id: 3 };
    expect(Probe.strip(dto)).toEqual({ name: 'A', amount: 10 });
    expect(dto.id).toBe(3);
  });
});

describe('TenantCrudService company condition', () => {
  const service = (name: string) =>
    Object.assign(Object.create(TenantCrudService.prototype) as object, {
      model: { name, primaryKeyAttribute: 'id', getAttributes: () => ({ id: {}, companyId: {} }), getTableName: () => `${name}s` },
    }) as unknown as { pin(ctx: unknown): unknown; stamps(ctx: unknown): unknown; hasAttribute(name: string): boolean };
  const ctx = { user: { companyId: 7, id: 3 } };

  it("pins a company's rows to the company; a list every company shares (partition.exempt) gets no company condition or stamp", async () => {
    const { PARTITION } = await import('../tenancy/partition.js');
    const before = [...PARTITION.exempt];
    PARTITION.exempt.push('State');
    try {
      expect(service('Party').pin(ctx)).toEqual({ companyId: 7 });
      expect(service('State').pin(ctx)).toEqual({});
      const shared = service('State');
      shared.hasAttribute = (field: string) => field === 'companyId';
      expect(shared.stamps(ctx)).toEqual({});
    } finally {
      PARTITION.exempt.splice(0, PARTITION.exempt.length, ...before);
    }
  });
});
