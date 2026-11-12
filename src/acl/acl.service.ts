import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import type { AclScope, AuthUser, Limits } from '../auth/auth-user.js';
import { BUS_TOPICS, ClusterBus } from '../cluster/cluster-bus.js';
import { ACL_SOURCE, type AclSource } from '../features.js';

/** What one permission is granted with: how far it reaches and what authority limits apply. */
export interface Grant {
  scope: AclScope;
  limits: Limits;
  /** Data the scope needs, when the grant carries it (the branch ids a permission is given for). */
  params?: Record<string, unknown>;
}

export type EffectivePermissions = Map<string, Grant>;

const TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;

/**
 * The effective permissions of a user, from the configured `AclSource` (the framework's role tables,
 * or the project's own). Cached in process for a minute, keyed by
 * company, user, role and the role's ACL version, so editing a role takes effect on the next
 * refresh. Two companies never share a cache entry even when a user id repeats. `forgetUser` and
 * `forgetCompany` reach every process through the cluster bus.
 */
@Injectable()
export class AclService implements OnModuleInit {
  private readonly cache = new Map<string, { at: number; value: EffectivePermissions }>();

  constructor(
    @Inject(ACL_SOURCE) private readonly source: AclSource,
    @Optional() private readonly bus?: ClusterBus,
  ) {}

  onModuleInit(): void {
    this.bus?.subscribe<{ companyId: number; userId?: number }>(BUS_TOPICS.acl, ({ companyId, userId }) =>
      userId === undefined ? this.drop(`${companyId}:`) : this.drop(`${companyId}:${userId}:`),
    );
  }

  private key(companyId: number, userId: number, roleId: number | null, version: number): string {
    return `${companyId}:${userId}:${roleId ?? 0}:${version}`;
  }

  async effective(user: AuthUser): Promise<EffectivePermissions> {
    const key = this.key(user.companyId, user.id, user.roleId, user.aclVersion);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await this.load(user);
    if (this.cache.size >= MAX_ENTRIES) this.cache.clear();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Drop cached sets for one user of one company (after override edits), in every process. */
  forgetUser(companyId: number, userId: number): void {
    this.drop(`${companyId}:${userId}:`);
    void this.bus?.publish(BUS_TOPICS.acl, { companyId, userId });
  }

  /** Drop everything cached for a company (after a move or a bulk change), in every process. */
  forgetCompany(companyId: number): void {
    this.drop(`${companyId}:`);
    void this.bus?.publish(BUS_TOPICS.acl, { companyId });
  }

  private drop(prefix: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
  }

  /** Uncached: what the configured source says now. */
  load(user: AuthUser, t?: Transaction): Promise<EffectivePermissions> {
    return this.source.load(user, t);
  }
}
