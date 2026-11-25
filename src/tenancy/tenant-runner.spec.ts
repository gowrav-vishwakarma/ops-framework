import { describe, expect, it } from 'vitest';
import { TenantRunner } from './tenant-runner.js';

const routes = [
  { companyId: 1, dbKey: 'main', schema: 'tenant_1', epoch: 0 },
  { companyId: 2, dbKey: 'main', schema: 'tenant_2', epoch: 0 },
];

function runner() {
  const placements = { activeRoutes: async () => routes, resolve: async () => routes[0] };
  const registry = { get: async () => ({}) };
  return new TenantRunner(placements as never, registry as never);
}

describe('TenantRunner.forEach', () => {
  it('reports failing tenants and runs the rest', async () => {
    const ran: number[] = [];
    const failures = await runner().forEach(async (ref) => {
      ran.push(ref.companyId);
      if (ref.companyId === 1) throw new Error('boom');
    });
    expect(ran).toEqual([1, 2]);
    expect(failures).toEqual([{ companyId: 1, error: new Error('boom') }]);
  });

  it('label names the job in each failure', async () => {
    const failures = await runner().forEach(async () => {
      throw new Error('boom');
    }, { label: 'gps-sync' });
    expect(failures.map((f) => f.label)).toEqual(['gps-sync', 'gps-sync']);
  });
});
