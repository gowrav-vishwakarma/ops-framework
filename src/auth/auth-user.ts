/**
 * Name of a data scope: `all`, `branch`, `own`, or one an app or a resource declares
 * (`active-only`). An unknown scope is denied, never treated as `all`.
 */
export type AclScope = string;

/** Authority limits of a grant: `{ amount: 5000 }`. An absent key is unlimited. */
export type Limits = Record<string, number>;

/** Whoever runs an operation: a company's user or a platform admin. */
export interface Actor {
  id: number;
  name: string;
  roleId: number | null;
  /** Version of the role's permission set when the token was issued. */
  aclVersion: number;
}

/**
 * Project fields on the signed-in user. Extend it by declaration merging, so steps see them typed:
 *
 * ```ts
 * declare module '@ops/framework' {
 *   interface AuthUserExtension { financialYearId: number | null }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AuthUserExtension {}

/** The signed-in user, rebuilt from the company token on every request. */
export interface AuthUser extends Actor, AuthUserExtension {
  /** The tenant-local user id: what audit columns, ACL and tenant joins use. */
  id: number;
  /** The control-plane identity id (`sub` of the token). */
  platformUserId: number;
  /** The partition: the company the token was issued for. */
  companyId: number;
  /** The project's string key for the tenant, when it has one (Ankpal: the tenant schema name). */
  tenantKey?: string | null;
  /** Routing epoch the token was issued under; with `auth.epoch: 'required'` a mismatch forces a new sign-in. 0 when unused. */
  epoch: number;
  branchId: number | null;
  branchIds: number[];
  roleId: number | null;
  aclVersion: number;
  /** Driver or customer party for portal users; widens the `own` scope to that party's rows. */
  partyId: number | null;
  name: string;
}

/**
 * A platform admin (control plane), rebuilt from an admin token (`typ: 'admin'`). Who admins are
 * (staff, partners, resellers) is the project's: `kind` and `extra` carry what its scopes need.
 */
export interface AdminUser extends Actor {
  kind: string;
  extra: Record<string, unknown>;
}

/** What a controller hands its service: who is asking, how far the permission reaches, and its limits. */
export interface ReqCtx<U extends Actor = AuthUser> {
  user: U;
  scope: AclScope;
  /** Authority limits of the granted permission; checked before the steps run. */
  limits: Limits;
  /** What the grant carries for its scope (`Grant.params`), e.g. `{ branchIds: [1, 4] }`. */
  scopeParams?: Record<string, unknown>;
}
