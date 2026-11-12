import type { AdminUser } from '../../../auth/auth-user.js';
import { step } from '../../../crud/op-context.js';
import type { AdminRole } from '../../admin-role.model.js';

export default step<AdminRole, object, object, AdminUser>({
  async check({ row, issues }) {
    if (row.isSystem) issues.block('system_role', 'A system role cannot be deleted');
  },
});
