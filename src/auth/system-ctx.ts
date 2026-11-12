import type { ReqCtx } from './auth-user.js';

/**
 * A context for work no signed-in user started: cron jobs, imports, queue consumers. It reaches
 * every row of the company (`scope: 'all'`, no limits) and is recorded as user 0, "System", in the audit
 * trail. Pass it to a service like any request context: `service.perform(systemCtx(companyId), id, 'close')`.
 * Run it inside `TenantRunner.run()` so the tenant's connection and schema are set.
 */
export function systemCtx(companyId: number): ReqCtx {
  return {
    scope: 'all',
    limits: {},
    user: { id: 0, platformUserId: 0, companyId, epoch: 0, branchId: null, branchIds: [], roleId: null, aclVersion: 0, partyId: null, name: 'System' },
  };
}
