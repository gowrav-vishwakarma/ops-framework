import { getAttributes } from 'sequelize-typescript';
import { describe, expect, it } from 'vitest';
import { definePartition, partitionValue, PARTITION } from './partition.js';

// Must run before any model is imported: models read the partition when they are declared.
definePartition({ field: 'tenantKey', column: 'tenant_key', mirror: 'tenants' });
const { PartitionedModel, tenantTable } = await import('../db/tenant.model.js');

describe('a configurable partition column', () => {
  it('models carry the configured attribute, referencing the configured mirror table', () => {
    const attributes = getAttributes(PartitionedModel.prototype) as Record<string, { references?: { model: string } }>;
    expect(Object.keys(attributes)).toContain('tenantKey');
    expect(Object.keys(attributes)).not.toContain('companyId');
    expect(attributes.tenantKey?.references?.model).toBe('tenants');
  });

  it('table helpers index the configured column and the value is read from the configured field', () => {
    expect(tenantTable('things').indexes?.[0]).toEqual({ fields: ['tenant_key'] });
    expect(partitionValue({ tenantKey: 42 })).toBe(42);
    expect(PARTITION).toMatchObject({ field: 'tenantKey', column: 'tenant_key', mirror: 'tenants' });
  });
});
