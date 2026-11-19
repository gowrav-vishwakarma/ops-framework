import { IsDefined, IsIn } from 'class-validator';
import type { Type } from '@nestjs/common';
import { NoPayload } from '../payload/check-payload.js';
import type { Model } from 'sequelize-typescript';
import type { Actor, AuthUser } from '../auth/auth-user.js';
import type { EntityAction } from './entity-action.js';

type StatusValue = string | number | boolean;

interface StatusActionOptions {
  /** Singular noun for messages: "branch". */
  noun: string;
  /** Column holding the state. */
  field?: string;
  active?: string;
  inactive?: string;
  /** States `activate` may start from. */
  activateFrom?: readonly string[];
  /** States `deactivate` may start from. */
  deactivateFrom?: readonly string[];
  /** Also a `bulk` action setting the status of many records (`true`: named `bulk-status`; a string names it). See `bulkStatusAction`. */
  bulk?: boolean | string;
}

/**
 * The `activate` and `deactivate` actions most masters share. They only set the status; an
 * entity's own checks and side effects go in `ops/deactivate/` and `ops/activate/`.
 * With `bulk`, a third action sets the status of many records by running activate or deactivate on each.
 */
export function statusActions<M extends Model, U extends Actor = AuthUser>(options: StatusActionOptions): EntityAction<M, U>[] {
  const field = options.field ?? 'status';
  const active = options.active ?? 'active';
  const inactive = options.inactive ?? 'inactive';

  const actions: EntityAction<M, U>[] = [
    {
      name: 'deactivate',
      label: 'Deactivate',
      from: { [field]: options.deactivateFrom ?? [active] },
      confirm: `Deactivate this ${options.noun}?`,
      danger: true,
      input: NoPayload,
      run: setStatus(field, inactive),
      effect: `${field} -> ${inactive}`,
    },
    {
      name: 'activate',
      label: 'Activate',
      from: { [field]: options.activateFrom ?? [inactive] },
      confirm: `Activate this ${options.noun}?`,
      input: NoPayload,
      run: setStatus(field, active),
      effect: `${field} -> ${active}`,
    },
  ];
  if (!options.bulk) return actions;
  return [
    ...actions,
    bulkStatusAction<M, U>({
      name: typeof options.bulk === 'string' ? options.bulk : 'bulk-status',
      noun: options.noun,
      field,
      values: [active, inactive],
      rowAction: (value) => (value === active ? 'activate' : 'deactivate'),
    }),
  ];
}

interface BulkStatusOptions {
  /** Action name (route, permission): `bulk-status`, or a project's own (`bulkUpdateStatus`). */
  name?: string;
  /** Plural or singular noun for messages: "branches". */
  noun: string;
  label?: string;
  /** Column holding the state. */
  field?: string;
  /** The values the input `status` may take: the column's own (`'active'`, `'inActive'`; `true`, `false`). */
  values: readonly StatusValue[];
  /**
   * The row action that sets `value` (`activate` / `deactivate`): each record runs it exactly as
   * `POST /:id/actions/<action>` would (see `EntityAction.each`). Without it the action sets the column itself, for an
   * entity whose status is only in its form; its `ops/<name>/` steps do the rest.
   */
  rowAction?: (value: StatusValue) => string;
}

/**
 * A `bulk` action that sets the status of the chosen records: `POST /actions/<name>` with `{ ids, status }`. `status`
 * takes the entity's own values only (a boolean column takes `true` / `false`). Records are all checked first, blockers
 * come back per record, then every record changes, each audited, in one transaction.
 */
export function bulkStatusAction<M extends Model, U extends Actor = AuthUser>(options: BulkStatusOptions): EntityAction<M, U> {
  const field = options.field ?? 'status';
  const { rowAction } = options;
  return {
    name: options.name ?? 'bulk-status',
    label: options.label ?? 'Update status',
    kind: 'bulk',
    confirm: `Update the status of the selected ${options.noun}?`,
    input: statusInput(options.values, `${options.noun.replace(/(^|\W+)(\w)/g, (_, __, c: string) => c.toUpperCase())}StatusInput`),
    ...(rowAction
      ? { each: (input: object) => rowAction((input as { status: StatusValue }).status) }
      : { run: async (c) => setStatus<M, U>(field, (c.dto as { status: StatusValue }).status)!(c) }),
    effect: rowAction ? `each record: ${[...new Set(options.values.map(rowAction))].join(' or ')} (by status)` : `${field} -> status`,
  };
}

/**
 * `{ status }` limited to `values`, with no type conversion: `"true"` is not `true`. `name` is the class name (the
 * contract's schema name): one per entity, as each has its own values.
 */
export function statusInput(values: readonly StatusValue[], name = 'StatusInput'): Type<object> {
  class StatusInput {
    @IsDefined()
    @IsIn(values)
    status!: StatusValue;
  }
  Object.defineProperty(StatusInput, 'name', { value: name });
  return StatusInput;
}

function setStatus<M extends Model, U extends Actor>(field: string, value: StatusValue): EntityAction<M, U>['run'] {
  return async ({ row, ctx, t }) => {
    const stamp = 'updatedById' in (row.constructor as unknown as { getAttributes(): object }).getAttributes() ? { updatedById: ctx.user.id } : {};
    await row.update({ [field]: value, ...stamp } as never, { transaction: t });
  };
}
