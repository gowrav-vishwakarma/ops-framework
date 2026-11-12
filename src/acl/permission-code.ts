import type { FrameworkOptions } from '../options.js';

/** Default names of the built-in operations: a list is guarded by `view` unless the project renames `list`. */
const DEFAULT_ACTIONS: Record<string, string> = { list: 'view' };

/** The permission code of `action` on `resource` as the project spells it (`FrameworkOptions.acl`). */
export function permissionCode(options: Pick<FrameworkOptions, 'acl'> | undefined, resource: string, action: string): string {
  const name = options?.acl?.actionNames?.[action] ?? DEFAULT_ACTIONS[action] ?? action;
  return options?.acl?.code ? options.acl.code(resource, name) : `${resource}.${name}`;
}
