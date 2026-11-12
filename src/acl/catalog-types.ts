import type { LimitInfo } from './limits.js';
import type { ScopeRef } from './scopes.js';

export const CRUD = ['view', 'create', 'update', 'delete'] as const;

/** One resource and the actions a role can be granted on it. */
export interface ResourceDef {
  resource: string;
  label: string;
  actions: readonly string[];
  /** Scope ids the matrix offers for this resource. Defaults to `all`, `branch`, `own`. */
  scopes?: readonly string[];
  /** Limits a grant of an action can carry, by action name. The service that enforces it declares the `value`. */
  limits?: Readonly<Record<string, readonly LimitInfo[]>>;
}

/** A matrix section; also the menu group. */
export interface PermissionGroup {
  group: string;
  resources: ResourceDef[];
}

export interface PermissionEntry {
  resource: string;
  action: string;
  code: string;
  label: string;
  groupName: string;
  sortOrder: number;
  /** Scope ids a grant of this permission may carry. */
  scopes: readonly string[];
  /** Limit keys a grant of this permission may carry. */
  limits: readonly LimitInfo[];
}

/** Re-exported so an app imports every ACL declaration from one place. */
export type { LimitInfo, ScopeRef };
