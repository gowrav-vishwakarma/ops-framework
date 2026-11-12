import { IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Matches, Min } from 'class-validator';
import { command, defineContract, query } from '../services/contract.js';

/**
 * The two contracts the framework itself relies on between a project's platform service (control
 * plane: its own identities, companies, licenses, partners...) and its tenant service. The project
 * implements both on the tenant side and calls them from its platform side. Everything else the
 * two say to each other (invitations, seats, membership events) the project defines in its own
 * contracts.
 */

// ---------------------------------------------------------------------------------------------
// TenantSessions: who a person is inside one company, for the picker and the company token.
// ---------------------------------------------------------------------------------------------

export class SessionRefDto {
  /** The person's control-plane identity (the token's `sub`). */
  @IsInt()
  @Min(1)
  platformUserId: number;

  /**
   * What the person chose with the company, passed through untouched: a role, a branch, a
   * financial year. The tenant decides what it accepts.
   */
  @IsOptional()
  @IsObject()
  choice?: Record<string, unknown>;
}

/** One company in the picker, as the tenant sees the person. */
export interface SessionProfile {
  /** False: no usable profile in this company (no user, blocked, no role). */
  active: boolean;
  /** Anything the picker shows: the role, the roles to choose from, branches. */
  details?: Record<string, unknown>;
}

/** What the company token carries besides what the framework adds (`sub`, `uid`, `cmp`, `ep`, `typ`). */
export interface SessionClaims {
  /** The tenant-local user id (`uid`). */
  userId: number;
  /** Project claims, read back by `FrameworkOptions.auth.userClaims`. */
  claims: Record<string, unknown>;
}

export const TenantSessions = defineContract({
  name: 'tenant-sessions',
  plane: 'tenant',
  calls: {
    profile: query<SessionRefDto, SessionProfile>(SessionRefDto),
    /** Opens a session for the person in the call's company; throws (403) when they may not. */
    open: command<SessionRefDto, SessionClaims>(SessionRefDto),
  },
});

// ---------------------------------------------------------------------------------------------
// TenantProvisioning: builds a company's place. Only the tenant service reaches tenant databases.
// ---------------------------------------------------------------------------------------------

export class ProvisionTenantDto {
  @IsInt()
  @Min(1)
  companyId: number;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  code: string;

  /** Any database (shard key) ... */
  @IsString()
  @Matches(/^[a-z_][a-z0-9_]{0,62}$/)
  dbKey: string;

  /** ... and any schema: shared with other companies (`tenant_shared`) or its own (`tenant_42`). */
  @IsString()
  @Matches(/^[a-z_][a-z0-9_]{0,62}$/)
  schema: string;

  /** The project's own seed input (branches, the first administrator...). */
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

export const TenantProvisioning = defineContract({
  name: 'tenant-provisioning',
  // The route and the call's dedupe record live on the control plane; the handler builds the tenant's place.
  plane: 'control',
  calls: {
    /** Creates or completes the company's place (`TenantLifecycle.provision`) and seeds it. Must be safe to repeat. */
    provision: command<ProvisionTenantDto, Record<string, unknown>>(ProvisionTenantDto),
  },
});
