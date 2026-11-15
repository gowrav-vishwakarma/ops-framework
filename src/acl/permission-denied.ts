import { ForbiddenException } from '@nestjs/common';
import type { FrameworkOptions } from '../options.js';
import { FRAMEWORK_ACTION_LABELS } from './catalog.js';

/** The `code` of a 403 that says the user's role was not given a right (the owner or an administrator can give it). */
export const PERMISSION_DENIED = 'PERMISSION_DENIED';

/**
 * The user's role lacks a right. The body says so in words a person reads, apart from a licence refusal (the plan) or a
 * system refusal: `{ statusCode: 403, code: 'PERMISSION_DENIED', message, permission? }`.
 */
export class PermissionDeniedException extends ForbiddenException {
  constructor(message: string, readonly permission?: string) {
    super({ statusCode: 403, error: 'Forbidden', code: PERMISSION_DENIED, message, ...(permission ? { permission } : {}) });
  }
}

/** `SalesmanCommission` / `fuel_entry` → `salesman commission` / `fuel entry`. */
export function humanizeName(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .toLowerCase();
}

/** What `code` lets a person do, in words: the catalog's label, else `<action label> <resource>` (`edit account`). */
export function permissionLabel(options: Partial<Pick<FrameworkOptions, 'acl' | 'catalog'>> | undefined, code: string): string {
  const entry = options?.catalog?.find((item) => item.code === code);
  if (entry) return entry.label.toLowerCase();
  const dot = code.lastIndexOf('.');
  if (dot < 0) return humanizeName(code);
  const resource = code.slice(0, dot);
  const action = code.slice(dot + 1);
  const labels: Record<string, string> = { ...FRAMEWORK_ACTION_LABELS, ...options?.acl?.actionLabels };
  return `${(labels[action] ?? humanizeName(action)).toLowerCase()} ${humanizeName(resource)}`;
}

/** The refusal for a missing `code`: "You don't have permission to edit account. Ask the owner or your administrator …". */
export function permissionDenied(options: Partial<Pick<FrameworkOptions, 'acl' | 'catalog'>> | undefined, code: string): PermissionDeniedException {
  return new PermissionDeniedException(`You don't have permission to ${permissionLabel(options, code)}. Ask the owner or your administrator to give you this right.`, code);
}
