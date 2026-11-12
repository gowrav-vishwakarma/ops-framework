import { Injectable, UnprocessableEntityException, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import type { Transaction } from 'sequelize';
import type { Model, ModelCtor } from 'sequelize-typescript';
import { ScopeRegistry } from '../acl/scope-registry.js';
import type { ScopeDef, ScopeEnv } from '../acl/scopes.js';
import type { Actor, ReqCtx } from '../auth/auth-user.js';
import { preparedFor, RowGuardRegistry } from './row-guard.js';

/**
 * Who the running operation writes for. The CRUD engine sets it around an operation's steps, so
 * every write made while it runs (the main change, flow steps, code steps, services they call) is
 * checked the same way:
 *  - the row guards of the model written (a closed financial year, a period lock);
 *  - the caller's data scope: the operation's own records against the whole scope (branch, own,
 *    the branches a grant names); rows of other models against the scopes that split data along a
 *    dimension those rows carry too (`ScopeDef.related`: a branch-limited user cannot move stock or
 *    post a ledger row in another branch), never against ownership (a salesman limited to his own
 *    invoices still takes stock from lots someone else created).
 */
export interface OperationAccess {
  ctx: ReqCtx<Actor>;
  can(code: string): Promise<boolean>;
  /** The model the operation is about (its own records get the whole scope). */
  model: string;
  scopeEnv: ScopeEnv;
  /** The operation's resolved scope (a resource may declare its own); else the registered one by id. */
  scope?: ScopeDef;
  /** Guards of the operation's own model this operation skips (`skipGuards` of an action). */
  skipGuards: readonly string[];
}

const ACCESS = 'framework:operation-access';
const SYSTEM = 'framework:write-as-system';

function cls() {
  try {
    const service = ClsServiceManager.getClsService();
    return service.isActive() ? service : undefined;
  } catch {
    return undefined;
  }
}

/** The running operation's access, or undefined outside one (sign-in, jobs, migrations). */
export function operationAccess(): OperationAccess | undefined {
  return cls()?.get<OperationAccess | undefined>(ACCESS);
}

/** True inside `asSystem()`: the caller's scope does not limit writes (row guards still do). */
export function writingAsSystem(): boolean {
  return cls()?.get<boolean | undefined>(SYSTEM) === true;
}

function within<T>(values: Record<string, unknown>, work: () => Promise<T>): Promise<T> {
  const service = cls();
  if (!service) return work();
  return service.run({ ifNested: 'inherit' }, () => {
    for (const [key, value] of Object.entries(values)) service.set(key, value);
    return work();
  });
}

/** Runs `work` as one operation: every write in it is checked against `access`. */
export function runAsOperation<T>(access: OperationAccess, work: () => Promise<T>): Promise<T> {
  return within({ [ACCESS]: access, [SYSTEM]: false }, work);
}

/**
 * Writes the system makes for the operation whatever the caller's scope (an integrity update of a
 * shared master). Row guards still apply. Say why where you use it.
 */
export function asSystem<T>(work: () => Promise<T>): Promise<T> {
  return within({ [SYSTEM]: true }, work);
}

export const outOfScope = (model: string) =>
  new UnprocessableEntityException({ message: `Outside your access scope (${model})`, errors: {}, blockers: [{ code: 'out_of_scope', message: `Outside your access scope (${model})`, refType: model }] });

const refusedByGuard = (model: string, code: string, message: string) =>
  new UnprocessableEntityException({ message, errors: {}, blockers: [{ code, message, refType: model }] });

type Op = 'create' | 'update' | 'delete';

/** The checks themselves; the model hooks call the instance the framework registers at boot. */
@Injectable()
export class WriteGuard implements OnModuleInit {
  private static current: WriteGuard | undefined;

  constructor(
    private readonly scopes: ScopeRegistry,
    private readonly guards: RowGuardRegistry,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    WriteGuard.current = this;
  }

  static get instance(): WriteGuard | undefined {
    return WriteGuard.current;
  }

  /** Whether writes to `model` need a per-row look in this operation (bulk writes then load their rows). */
  needsRows(model: ModelCtor<Model>, access: OperationAccess): boolean {
    if (this.guards.for(model.name).length) return true;
    return !writingAsSystem() && this.scopes.writeRule(access.ctx as ReqCtx, model, model.name === access.model, access.scopeEnv, access.scope) !== null;
  }

  async check(model: ModelCtor<Model>, op: Op, row: Model, before: Record<string, unknown> | null, t: Transaction | undefined): Promise<void> {
    const access = operationAccess();
    if (!access) return;
    const own = model.name === access.model;
    if (!writingAsSystem()) {
      const allows = this.scopes.writeRule(access.ctx as ReqCtx, model, own, access.scopeEnv, access.scope);
      const beforeRow = before ? ({ get: (key: string) => before[key] } as unknown as Model) : null;
      if (allows && (!allows(row) || (beforeRow && !allows(beforeRow)))) throw outOfScope(model.name);
    }
    const get = <T>(token: unknown) => this.moduleRef.get<T>(token as never, { strict: false });
    for (const guard of this.guards.for(model.name)) {
      if (own && access.skipGuards.includes(guard.id)) continue;
      const prepared = t ? await preparedFor(guard, access.ctx as never, get, t) : guard.prepare ? await guard.prepare(access.ctx as never, get) : undefined;
      const reason = await guard.reason({ op, row, before, ctx: access.ctx as never, prepared, can: access.can });
      if (reason) throw refusedByGuard(model.name, guard.code ?? guard.id, reason);
    }
  }
}

type HookOptions = { transaction?: Transaction; individualHooks?: boolean };

/** Hooks on one tenant model: every create, update and delete inside an operation goes through `WriteGuard.check`. */
export function installWriteGuardHooks(model: ModelCtor<Model>): void {
  const check = (op: Op, row: Model, before: Record<string, unknown> | null, options: HookOptions) => WriteGuard.instance?.check(model, op, row, before, options?.transaction);
  model.addHook('beforeCreate', 'framework:write-guard-create', ((row: Model, options: HookOptions) => check('create', row, null, options)) as never);
  model.addHook('beforeBulkCreate', 'framework:write-guard-bulk-create', (async (rows: Model[], options: HookOptions) => {
    for (const row of rows) await check('create', row, null, options);
  }) as never);
  model.addHook('beforeUpdate', 'framework:write-guard-update', ((row: Model, options: HookOptions) =>
    check('update', row, { ...((row as unknown as { _previousDataValues: Record<string, unknown> })._previousDataValues ?? {}) }, options)) as never);
  model.addHook('beforeDestroy', 'framework:write-guard-destroy', ((row: Model, options: HookOptions) => check('delete', row, { ...(row.get({ plain: true }) as Record<string, unknown>) }, options)) as never);
  // A bulk update or delete names rows by a condition; when they need a look, load them so the
  // per-row hooks above run (Sequelize's `individualHooks`).
  const perRow = (options: HookOptions) => {
    const access = operationAccess();
    if (access && WriteGuard.instance?.needsRows(model, access)) options.individualHooks = true;
  };
  model.addHook('beforeBulkUpdate', 'framework:write-guard-bulk-update', perRow as never);
  model.addHook('beforeBulkDestroy', 'framework:write-guard-bulk-destroy', perRow as never);
}
