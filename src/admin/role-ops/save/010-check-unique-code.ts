import type { AdminUser } from '../../../auth/auth-user.js';
import { step } from '../../../crud/op-context.js';
import type { AdminRole } from '../../admin-role.model.js';

export default step<AdminRole, object, object, AdminUser>({
  async check({ unique }) {
    await unique('code');
  },
});
