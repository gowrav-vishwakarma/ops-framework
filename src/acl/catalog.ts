import { DEFAULT_SCOPE_IDS } from './scopes.js';
import type { PermissionEntry, PermissionGroup } from './catalog-types.js';

/** Words for the action names the framework adds itself; an app passes its own on top. */
export const FRAMEWORK_ACTION_LABELS: Record<string, string> = {
  view: 'View',
  create: 'Create',
  update: 'Edit',
  delete: 'Delete',
  restore: 'Restore',
  export: 'Export',
  unlock: 'Unlock',
};

/** Flattens the groups into one entry per `resource.action`, in display order. */
export function buildCatalog(groups: readonly PermissionGroup[], actionLabels: Record<string, string> = {}): PermissionEntry[] {
  const labels = { ...FRAMEWORK_ACTION_LABELS, ...actionLabels };
  const entries: PermissionEntry[] = [];
  for (const { group, resources } of groups) {
    for (const { resource, label, actions, scopes, limits } of resources) {
      for (const action of actions) {
        entries.push({
          resource,
          action,
          code: `${resource}.${action}`,
          label: `${labels[action] ?? action} ${label.toLowerCase()}`,
          groupName: group,
          sortOrder: entries.length,
          scopes: scopes ?? DEFAULT_SCOPE_IDS,
          limits: limits?.[action] ?? [],
        });
      }
    }
  }
  return entries;
}

/** `fuel_entry.*`, `*.view`, `*.*` against a catalog. */
export function expandPattern(catalog: readonly PermissionEntry[], pattern: string): string[] {
  const [resource = '*', action = '*'] = pattern.split('.');
  return catalog
    .filter((entry) => (resource === '*' || entry.resource === resource) && (action === '*' || entry.action === action))
    .map((entry) => entry.code);
}
