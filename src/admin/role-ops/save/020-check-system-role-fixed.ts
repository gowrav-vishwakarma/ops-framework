import type { AdminUser } from '../../../auth/auth-user.js';
import { step } from '../../../crud/op-context.js';
import type { AdminRole } from '../../admin-role.model.js';
import type { CreateAdminRoleDto, UpdateAdminRoleDto } from '../../admin-role.dto.js';

/** A system role keeps its code and always holds every admin permission. */
export default step<AdminRole, object, CreateAdminRoleDto | UpdateAdminRoleDto, AdminUser>({
  async check({ row, before, dto, changed, issues }) {
    if (!row.isSystem || !before) return;
    if (changed('code')) issues.field('code', 'System role code is fixed');
    if (dto.permissions) issues.field('permissions', 'System role always has every permission');
  },
});
