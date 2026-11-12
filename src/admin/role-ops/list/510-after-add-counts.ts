import type { AdminUser } from '../../../auth/auth-user.js';
import { listStep } from '../../../crud/op-context.js';
import type { AdminRole } from '../../admin-role.model.js';

/** Adds `permissionCount` to each role of the page, in one grouped query. */
export default listStep<AdminRole, object, AdminUser>({
  async after({ rows, sql }) {
    if (rows.length === 0) return;
    const found = await sql<{ role_id: number; n: number }>(
      'SELECT role_id, count(*)::int AS n FROM admin_role_permissions WHERE role_id IN (:ids) GROUP BY role_id',
      { ids: rows.map((row) => row.id) },
    );
    const counts = new Map(found.map((r) => [r.role_id, r.n]));
    for (const row of rows) row.setDataValue('permissionCount' as never, (counts.get(row.id as number) ?? 0) as never);
  },
});
