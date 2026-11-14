import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { PermissionMeta } from '../acl/limits.js';
import type { EffectivePermissions } from '../acl/acl.service.js';
import type { AdminUser } from '../auth/auth-user.js';
import { ClusterBus } from '../cluster/cluster-bus.js';
import { ADMIN_ACL_SOURCE, type AdminAclSource } from '../features.js';

/** The admin side's own limits and hidden permissions; codes may repeat tenant ones without clashing. */
@Injectable()
export class AdminPermissionMeta extends PermissionMeta {}

const TTL_MS = 60_000;
const TOPIC = 'framework.admin-acl';

/**
 * An admin's permissions, from the admin permission source (`features.admin`: the framework's tables or the
 * project's own, `AdminAclSource`). Cached per process for a minute,
 * keyed by admin, role and the role's ACL version (in the token), so a role edit takes effect on the
 * next sign-in; `forget` drops the cache in every process at once.
 */
@Injectable()
export class AdminAclService implements OnModuleInit {
  private readonly cache = new Map<string, { at: number; value: EffectivePermissions }>();

  constructor(
    @Inject(ADMIN_ACL_SOURCE) private readonly source: AdminAclSource,
    @Optional() private readonly bus?: ClusterBus,
  ) {}

  onModuleInit(): void {
    this.bus?.subscribe(TOPIC, () => this.cache.clear());
  }

  async effective(admin: AdminUser): Promise<EffectivePermissions> {
    const key = `${admin.id}:${admin.roleId ?? 0}:${admin.aclVersion}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await this.source.load(admin);
    if (this.cache.size > 2_000) this.cache.clear();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** After a role's grants change, in every process. */
  forget(): void {
    this.cache.clear();
    void this.bus?.publish(TOPIC, {});
  }
}

