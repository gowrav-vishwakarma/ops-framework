import { BadRequestException, ForbiddenException, HttpException, Inject, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  Op,
  cast,
  col,
  where as sqlWhere,
  type FindAttributeOptions,
  type Includeable,
  type ModelStatic,
  type Order,
  type Transaction,
  type WhereOptions,
} from 'sequelize';
import type { Model } from 'sequelize-typescript';
import type { EffectivePermissions, Grant } from '../acl/acl.service.js';
import type { LimitDef } from '../acl/limits.js';
import { PermissionMeta } from '../acl/limits.js';
import { allScope, resolveScopes, type ScopeDef, type ScopeRef } from '../acl/scopes.js';
import type { Actor, ReqCtx } from '../auth/auth-user.js';
import { flattenValidationErrors } from '../errors.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { computeActionStates } from './action-states.js';
import type { ActionInfo, EntityAction } from './entity-action.js';
import { describeEntityFlow, type EntityFlow } from './flow.js';
import { Issues } from './issues.js';
import type { ListQueryDto, Paged } from './list-query.dto.js';
import { makeOpBase, countRows, type OpPlane } from './op-base.js';
import type { Attrs, CollectionContext, ListContext, OpBase, OpContext, Phase } from './op-context.js';

import { loadOps, OpsRegistry, sourceOf, type LoadedExecute, type LoadedStep } from './ops-loader.js';
import { permissionCode } from '../acl/permission-code.js';
import { limitsFor, runBuiltInChecks, startStateReason, type BuiltInChecks } from './row-checks.js';
import { guardsFor, RowGuardRegistry, type RowGuard } from './row-guard.js';
import { runAsOperation, type OperationAccess } from './write-guard.js';

export type { Attrs, EntityFlow };

/** Rows in `table` pointing at this one by `column`. Deleting a row that is still used is refused. */
export interface Dependent {
  table: string;
  column: string;
  /** Shown to the user: "trips", "users". */
  label: string;
  /** Extra SQL condition on the dependent table, e.g. `status <> 'cancelled'`. */
  condition?: string;
  /** The dependent table is soft-deleted: its deleted rows do not count. */
  paranoid?: boolean;
}

/** Brings a soft-deleted record back. Added to every service with `softDelete = true`. */
const restoreAction: EntityAction<Model, Actor> = {
  name: 'restore',
  label: 'Restore',
  onDeleted: true,
  effect: 'clear deleted_at',
  icon: 'restore_from_trash',
  async run(c) {
    await (c.row as Model & { restore(o: object): Promise<void> }).restore({ transaction: c.t });
  },
};

/**
 * List, read, create, update and delete, plus named actions, on one plane: a tenant's data
 * (`TenantCrudService`) or the control plane (`ControlCrudService`). Every query is pinned to what
 * the plane requires (the caller's company on a tenant) and to the granted permission's scope.
 *
 * Each operation runs the step files of `ops/<operation>/` in file-name order, in one
 * transaction (or the caller's, when another service passes `t`):
 *
 *   built-in checks        the service's row guards, authority limit (before the steps)
 *   NNN-check-*   001-399  read only; every problem is collected, then reported together
 *                          (warnings need the caller's confirmation)
 *   NNN-before-*  400-499  just before the main change
 *   main change            insert / update / delete / the action's `run`, or `500-execute.ts`
 *   NNN-after-*   501-999  children, related records, other entities, outbox
 *   audit row              in the plane's event table, listed by `history()`
 *
 * `save/` steps run on both create and update. The service itself is configuration only: lists,
 * `toCreate`/`toUpdate` mapping, `editLocks`, `dependents`, scopes, limits and the action declarations.
 */
export abstract class CrudService<
  M extends Model,
  TCreate extends object,
  TUpdate extends object = Partial<TCreate>,
  TQuery extends ListQueryDto = ListQueryDto,
  U extends Actor = Actor,
> implements OnModuleInit {
  protected abstract readonly model: ModelStatic<M>;
  @Inject(ModuleRef) protected readonly moduleRef: ModuleRef;

  // ---- the plane: implemented by TenantCrudService and ControlCrudService ----------------
  /** A new transaction on the plane. */
  protected abstract planeTx<T>(work: (t: Transaction) => Promise<T>): Promise<T>;
  /** What every query must also match on this plane (the caller's company), or null. */
  protected abstract pin(ctx: ReqCtx<U>): WhereOptions | null;
  /** Columns set on a new row besides the DTO (company, created by). */
  protected abstract stamps(ctx: ReqCtx<U>): Attrs;
  /** Column set on every update (updated by). */
  protected abstract updateStamps(ctx: ReqCtx<U>): Attrs;
  /** The caller's permissions on this plane. */
  abstract effective(ctx: ReqCtx<U>): Promise<EffectivePermissions>;
  /** Scopes registered for this plane (built-ins plus the app's). */
  protected abstract registeredScopes(options: FrameworkOptions): ScopeDef<Model, Actor>[];
  /** Default scopes of a resource that declares none. */
  protected abstract readonly defaultScopes: readonly ScopeRef[];
  /** Where this plane's services declare limits and hidden permissions. */
  protected abstract readonly metaToken: typeof PermissionMeta;
  protected abstract recordEvent(t: Transaction, ctx: ReqCtx<U>, entityId: number, event: string, data: Attrs | null): Promise<void>;
  protected abstract historyRows(ctx: ReqCtx<U>, id: number): Promise<unknown[]>;
  /** What steps get for `c.separate` and `c.can`. */
  protected abstract opPlane(): OpPlane<U>;

  /** Permission resource, e.g. `party`. Needed for named actions. */
  readonly resource: string = '';
  /** Folder of this entity's operations: `opsFolder(import.meta.url)`. None means no steps. */
  protected readonly opsDir: string | null = null;
  /** Attributes (or `$alias.field$` paths) the `q` search matches. */
  protected readonly searchFields: string[] = [];
  /** Keys a client may sort on: attributes, or `alias.field` on a list include. */
  protected readonly sortable: string[] = ['id', 'createdAt'];
  /** Keys the grid filter row may match (text ILIKE). Defaults to `sortable`. */
  protected readonly filterable: string[] | null = null;
  protected readonly defaultOrder: Order = [['id', 'DESC']];
  protected readonly label: string = 'Record';
  /** Party columns that make a row "own" for a driver or customer login. */
  protected readonly partyFields: string[] = [];
  /** Rows elsewhere that block deleting this one. Checked before the delete's own check steps. */
  protected readonly dependents: Dependent[] = [];
  /** Operations beyond edit. Their steps are in `ops/<name>/`. */
  protected readonly actions: EntityAction<M, U>[] = [];
  /**
   * Scopes a permission on this resource can carry: ids of built-in or registered scopes, or a
   * `ScopeDef` written in place. The role matrix offers exactly these.
   */
  protected readonly scopes: readonly ScopeRef[] | null = null;
  /** Authority limits of `create`, `update` and `delete` (an action declares its own): `{ update: [amountLimit] }`. */
  protected readonly limits: Partial<Record<string, readonly LimitDef<M>[]>> = {};
  /**
   * Project rules every write must pass before its check steps (a period lock, a closed financial
   * year): `guards = [periodLock('invoiceDate')]`. Also shown in `_actions`. See `RowGuard`.
   */
  protected readonly guards: readonly RowGuard<M, U>[] = [];
  /** Delete keeps the row (`deleted_at`); needs a paranoid model (`tenantTable(..., { softDelete: true })`). */
  protected readonly softDelete: boolean = false;

  private ops = new OpsRegistry();
  private frameworkOptions: FrameworkOptions | undefined;
  private scopeMap = new Map<string, ScopeDef>();
  private actionList: EntityAction<M, U>[] = [];
  private readonly logger = new Logger('Ops');

  async onModuleInit(): Promise<void> {
    const options = this.moduleRef.get<FrameworkOptions>(FRAMEWORK_OPTIONS, { strict: false });
    this.frameworkOptions = options;
    // Writes to this model from other operations (flow steps) run the same guards.
    try {
      this.moduleRef.get(RowGuardRegistry, { strict: false }).register(this.model.name, this.guards);
    } catch {
      // A test module without the framework module: no cross-model guard checks there.
    }
    this.scopeMap = resolveScopes(this.scopes ?? this.defaultScopes, this.registeredScopes(options)) as Map<string, ScopeDef>;
    if (this.softDelete && !this.model.options.paranoid) throw new Error(`${this.label}: softDelete needs a paranoid model (softDelete: true in its table options)`);
    this.actionList = this.softDelete ? [...this.actions, restoreAction as unknown as EntityAction<M, U>] : this.actions;
    this.declarePermissions();
    this.ops = await loadOps(this.opsDir, this.moduleRef, this.actionList.map((action) => action.name), { name: this.model.name, attributes: Object.keys(this.model.getAttributes()) });
  }

  /** Tells the role matrix which of this resource's permissions carry limits or stay hidden. */
  private declarePermissions(): void {
    if (!this.resource) return;
    const meta = this.moduleRef.get(this.metaToken, { strict: false });
    for (const [name, defs] of Object.entries(this.limits)) meta.declareLimits(`${this.resource}.${name}`, defs ?? []);
    for (const action of this.actionList) {
      const code = this.actionPermission(action);
      meta.declareLimits(code, action.limits ?? []);
      if (action.hideInAcl) meta.hide(code);
    }
  }

  protected listInclude(_query: TQuery): Includeable[] {
    return [];
  }

  protected listAttributes(): FindAttributeOptions | undefined {
    return undefined;
  }

  protected detailInclude(): Includeable[] {
    return this.listInclude({} as TQuery);
  }

  /** Extra where clauses from module-specific query params. */
  protected filters(_query: TQuery): WhereOptions[] {
    return [];
  }

  /** Attributes to store on create: plain mapping of the DTO (normalize case, drop non-columns). */
  protected async toCreate(_ctx: ReqCtx<U>, dto: TCreate, _t: Transaction): Promise<Attrs> {
    return { ...dto } as Attrs;
  }

  /** Attributes to set on update: plain mapping of the DTO. */
  protected async toUpdate(_ctx: ReqCtx<U>, dto: TUpdate, _row: M, _t: Transaction): Promise<Attrs> {
    return { ...dto } as Attrs;
  }

  /**
   * Fields that cannot be changed while the row is in its current state, with the reason:
   * `{ rate: 'LR is already billed' }`. Sent with the row so a form can lock those fields too.
   */
  protected editLocks(_row: M, _ctx: ReqCtx<U>): Record<string, string> {
    return {};
  }

  protected hasAttribute(name: string): boolean {
    return name in this.model.getAttributes();
  }

  /** Run in the caller's transaction when given, else open one on the plane. */
  protected inTx<T>(t: Transaction | undefined, work: (t: Transaction) => Promise<T>): Promise<T> {
    return t ? work(t) : this.planeTx(work);
  }

  /** Count rows in another table, e.g. `users WHERE branch_id = :id`. */
  protected countWhere(t: Transaction, sql: string, replacements: Record<string, unknown>): Promise<number> {
    return countRows(t, sql, replacements);
  }

  /** The plane's pin (the company) plus the reach of the granted permission's scope. An unknown scope is denied. */
  scopeWhere(ctx: ReqCtx<U>): WhereOptions {
    const scope = this.scopeMap.get(ctx.scope) ?? (ctx.scope === 'all' ? (allScope as ScopeDef) : undefined);
    if (!scope) throw new ForbiddenException(`Unknown access scope "${ctx.scope}"`);
    const parts = [this.pin(ctx), scope.where(ctx as never, this.model as never, { partyFields: this.partyFields })].filter((part): part is WhereOptions => part !== null);
    return (parts.length === 0 ? {} : parts.length === 1 ? parts[0] : { [Op.and]: parts }) as WhereOptions;
  }

  /** The caller's grant of `code` (scope and limits), or 403. */
  async grantOf(ctx: ReqCtx<U>, code: string): Promise<Grant> {
    const grant = (await this.effective(ctx)).get(code);
    if (!grant) throw new ForbiddenException(`You do not have permission: ${code}`);
    return grant;
  }

  /** Named actions the caller may run, for the toolbar and row menus. */
  async allowedActions(ctx: ReqCtx<U>) {
    const granted = await this.effective(ctx);
    return this.describeActions().filter((action) => granted.has(action.permission));
  }

  protected searchWhere(q: string | undefined): WhereOptions | null {
    const text = q?.trim();
    if (!text || this.searchFields.length === 0) return null;
    return { [Op.or]: this.searchFields.map((field) => ({ [field]: { [Op.iLike]: `%${text}%` } })) } as WhereOptions;
  }

  protected order(query: TQuery): Order {
    if (!query.sort || !this.sortable.includes(query.sort)) return this.defaultOrder;
    const direction = (query.dir ?? 'ASC').toUpperCase();
    return [[...query.sort.split('.'), direction] as [string, string]];
  }

  /** Raw `table.column` for an attribute or `alias.field` key. */
  private columnRef(key: string): string | null {
    const [first, second] = key.split('.');
    if (!first) return null;
    if (!second) {
      const attribute = this.model.getAttributes()[first];
      return attribute ? `${this.model.name}.${attribute.field ?? first}` : null;
    }
    const target = this.model.associations[first]?.target;
    const attribute = target?.getAttributes()[second];
    return attribute ? `${first}.${attribute.field ?? second}` : null;
  }

  protected columnFilterWhere(raw: string | undefined): WhereOptions[] {
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== 'object') return [];
    const allowed = this.filterable ?? this.sortable;
    const out: WhereOptions[] = [];
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
      const ref = allowed.includes(key) && text ? this.columnRef(key) : null;
      if (!ref) continue;
      out.push(sqlWhere(cast(col(ref), 'text'), { [Op.iLike]: `%${text}%` }));
    }
    return out;
  }

  // ---- reads ----------------------------------------------------------------------------

  /** Soft-deleted rows are only for callers who may restore them. */
  private async deletedAllowed(ctx: ReqCtx<U>, wanted: boolean): Promise<boolean> {
    if (!wanted) return false;
    if (!this.softDelete) throw new BadRequestException(`${this.label} has no deleted records`);
    const restore = this.permission('restore');
    if (!(await this.effective(ctx)).has(restore)) throw new ForbiddenException(`You do not have permission: ${restore}`);
    return true;
  }

  /**
   * The page of rows. Without `ops/list*` steps this is one query. With them, `before` steps may
   * add conditions, includes or ordering to the context, and `after` steps decorate the rows.
   * `?view=<name>` runs `ops/list-<view>/` after the shared `ops/list/` steps.
   */
  async list(ctx: ReqCtx<U>, query: TQuery): Promise<Paged<M>> {
    const op = query.view ? `list-${query.view}` : 'list';
    if (query.view && !this.ops.has(op)) throw new NotFoundException(`Unknown list view: ${query.view}`);
    const deleted = await this.deletedAllowed(ctx, query.deleted === '1');

    const where = [this.scopeWhere(ctx), ...this.filters(query), ...this.columnFilterWhere(query.filters)];
    const search = this.searchWhere(query.q);
    if (search) where.push(search);
    if (query.status && this.hasAttribute('status')) where.push({ status: query.status });
    if (deleted) where.push({ deletedAt: { [Op.ne]: null } });
    const page = {
      where,
      include: this.listInclude(query),
      order: this.order(query),
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
      attributes: this.listAttributes(),
    };

    let result: Paged<M>;
    if (this.ops.steps(op).length === 0) {
      result = await this.fetchPage(page, deleted);
    } else {
      result = await this.planeTx(async (t) => {
        const c: ListContext<M, Attrs, U> = { ...makeOpBase(this.opEnv(), op, ctx, t), query, ...page, rows: [], total: 0 };
        await this.runSteps(c, false, async () => {
          const found = await this.fetchPage(c, deleted, t);
          c.rows = found.rows;
          c.total = found.count;
        });
        return { rows: c.rows, count: c.total };
      });
    }
    if (query.actions === '1') await this.withActions(ctx, result.rows);
    return result;
  }

  private async fetchPage(
    page: Pick<ListContext<M, Attrs, U>, 'where' | 'include' | 'order' | 'limit' | 'offset' | 'attributes'>,
    deleted: boolean,
    t?: Transaction,
  ): Promise<Paged<M>> {
    const { rows, count } = await this.model.findAndCountAll({
      where: { [Op.and]: page.where } as WhereOptions,
      include: page.include,
      ...(page.attributes ? { attributes: page.attributes } : {}),
      order: page.order,
      limit: page.limit,
      offset: page.offset,
      distinct: true,
      ...(deleted ? { paranoid: false } : {}),
      ...(t ? { transaction: t } : {}),
    });
    return { rows, count };
  }

  async findOne(ctx: ReqCtx<U>, id: number, t?: Transaction, lock = false, withDeleted = false): Promise<M> {
    const row = await this.model.findOne({
      where: { [Op.and]: [this.scopeWhere(ctx), { id }] } as WhereOptions,
      ...(withDeleted ? { paranoid: false } : {}),
      ...(t ? { transaction: t } : {}),
      ...(lock && t ? { lock: t.LOCK.UPDATE } : {}),
    });
    if (!row) throw new NotFoundException(`${this.label} not found`);
    return row;
  }

  /** The row with its detail includes and `_locks`: fields the form must not let the user change now. */
  async get(ctx: ReqCtx<U>, id: number, t?: Transaction, options: { actions?: boolean; deleted?: boolean } = {}): Promise<M> {
    const deleted = await this.deletedAllowed(ctx, options.deleted === true);
    const row = await this.model.findOne({
      where: { [Op.and]: [this.scopeWhere(ctx), { id }] } as WhereOptions,
      include: this.detailInclude(),
      ...(deleted ? { paranoid: false } : {}),
      ...(t ? { transaction: t } : {}),
    });
    if (!row) throw new NotFoundException(`${this.label} not found`);
    const locks = this.editLocks(row, ctx);
    if (Object.keys(locks).length) row.setDataValue('_locks' as never, locks as never);
    if (options.actions) await this.withActions(ctx, [row]);
    return row;
  }

  /** Adds `_actions` to rows already loaded: what the caller may run on each, and why not. No query per row. */
  private async withActions(ctx: ReqCtx<U>, rows: M[]): Promise<void> {
    if (rows.length === 0) return;
    const granted = await this.effective(ctx);
    const get = <T>(token: unknown) => this.moduleRef.get<T>(token as never, { strict: false });
    const prepared = new Map<string, unknown>();
    for (const guard of this.guards) if (guard.prepare) prepared.set(guard.id, await guard.prepare(ctx, get));
    const env = {
      resource: this.resource,
      actions: this.actionList,
      limits: this.limits,
      guards: this.guards,
      scopes: this.scopeMap,
      scopeEnv: { partyFields: this.partyFields },
      model: this.model,
      actionPermission: (action: EntityAction<M, U>) => this.actionPermission(action),
      permission: (action: string) => this.permission(action),
    };
    for (const row of rows) row.setDataValue('_actions' as never, (await computeActionStates(env as never, ctx as never, row, granted, prepared)) as never);
  }

  // ---- writes ---------------------------------------------------------------------------

  private writeChecks(op: string, label: string): BuiltInChecks<M> {
    return { label, limits: limitsFor(op, this.limits), guards: this.guards };
  }

  async create(ctx: ReqCtx<U>, dto: TCreate, outer?: Transaction, confirmed = false): Promise<unknown> {
    let result: unknown;
    const id = await this.inTx(outer, async (t) => {
      const values = await this.toCreate(ctx, dto, t);
      const row = this.model.build({ ...values, ...this.stamps(ctx) } as never);
      const c = this.rowContext('create', ctx, t, row, null, dto);
      await this.runSteps(c, confirmed, async () => {
        await c.row.save({ transaction: t });
      }, { builtIn: this.writeChecks('create', 'Create') });
      await this.record(t, ctx, c.row.get('id') as number, 'create', this.snapshot(c.row.get({ plain: true }) as Attrs));
      result = c.result;
      return c.row.get('id') as number;
    });
    return result !== undefined ? result : this.get(ctx, id, outer);
  }

  async update(ctx: ReqCtx<U>, id: number, dto: TUpdate, outer?: Transaction, confirmed = false): Promise<unknown> {
    let result: unknown;
    await this.inTx(outer, async (t) => {
      const row = await this.findOne(ctx, id, t, true);
      const before = { ...row.get({ plain: true }) } as Attrs;
      const locks = this.editLocks(row, ctx);
      row.set((await this.toUpdate(ctx, dto, row, t)) as never);
      this.rejectLockedEdits(row, before, locks);

      const c = this.rowContext('update', ctx, t, row, before, dto);
      await this.runSteps(c, confirmed, async () => {
        c.row.set(this.updateStamps(ctx) as never);
        await c.row.save({ transaction: t });
      }, { builtIn: this.writeChecks('update', 'Edit') });
      const changes = this.diff(c.row, before);
      if (Object.keys(changes).length) await this.record(t, ctx, id, 'update', changes);
      result = c.result;
    });
    return result !== undefined ? result : this.get(ctx, id, outer);
  }

  async remove(ctx: ReqCtx<U>, id: number, outer?: Transaction, confirmed = false): Promise<unknown> {
    let result: unknown;
    await this.inTx(outer, async (t) => {
      const row = await this.findOne(ctx, id, t, true);
      const c = this.rowContext('delete', ctx, t, row, { ...row.get({ plain: true }) } as Attrs, {});
      await this.checkDependents(row, t, c.issues);
      await this.runSteps(c, confirmed, () => c.row.destroy({ transaction: t }), { builtIn: this.writeChecks('delete', 'Delete') });
      await this.record(t, ctx, id, 'delete', null);
      result = c.result;
    });
    return result !== undefined ? result : { id };
  }

  // ---- reads of one record -------------------------------------------------------------

  /**
   * A named read of one record: `ops/view-<name>/` steps build `c.result` (print data, usage
   * summary). Without a result it returns the record. Needs only the entity's `view` permission.
   */
  async view(ctx: ReqCtx<U>, id: number, name: string): Promise<unknown> {
    const op = `view-${name}`;
    if (!this.ops.has(op)) throw new NotFoundException(`Unknown view: ${name}`);
    let result: unknown;
    await this.planeTx(async (t) => {
      const row = await this.findOne(ctx, id, t);
      const c = this.rowContext(op, ctx, t, row, null, {});
      await this.runSteps(c, false, async () => undefined);
      result = c.result;
    });
    return result !== undefined ? result : this.get(ctx, id);
  }

  // ---- named actions -------------------------------------------------------------------

  /** The action definition, or 404. */
  actionDef(name: string): EntityAction<M, U> {
    const action = this.actionList.find((item) => item.name === name);
    if (!action) throw new NotFoundException(`Unknown action: ${name}`);
    return action;
  }

  /** Permission code an action needs, e.g. `party.deactivate`. */
  actionPermission(action: EntityAction<M, U>): string {
    return this.permission(action.permission ?? action.name);
  }

  /** The permission code of `action` on this resource, as the project spells it (`FrameworkOptions.acl`). */
  permission(action: string): string {
    return permissionCode(this.codeOptions(), this.resource, action);
  }

  /** Naming of permission codes on this plane; the control plane keeps the framework's own. */
  protected codeOptions(): Pick<FrameworkOptions, 'acl'> | undefined {
    return this.frameworkOptions;
  }

  describeActions(): Array<ActionInfo & { permission: string }> {
    return this.actionList.map((action) => ({
      name: action.name,
      label: action.label,
      from: action.from ?? null,
      confirm: action.confirm ?? null,
      kind: action.kind ?? 'row',
      danger: action.danger ?? false,
      inputs: action.inputs ?? [],
      limits: (action.limits ?? []).map(({ key, label, type }) => ({ key, label, type })),
      icon: action.icon ?? null,
      iconColor: action.iconColor ?? null,
      tooltip: action.tooltip ?? null,
      shortcut: action.shortcut ?? null,
      ui: action.ui ?? (action.inputs?.length ? 'form' : action.confirm ? 'confirm' : 'silent'),
      display: action.display ?? 'toolbar',
      group: action.group ?? null,
      hideInAcl: action.hideInAcl ?? false,
      permission: this.actionPermission(action),
    }));
  }

  private actionChecks(action: EntityAction<M, U>): BuiltInChecks<M> {
    return {
      label: action.label,
      limits: limitsFor(action.name, this.limits, action),
      guards: guardsFor(this.guards, action.skipGuards),
    };
  }

  /**
   * Run a `row` action on one record: its start state and input, then the steps of `ops/<name>/`
   * around the action's `run`, then an audit row. Warnings need `input.confirm === true`.
   */
  async perform(ctx: ReqCtx<U>, id: number, name: string, input: Record<string, unknown> = {}, outer?: Transaction): Promise<unknown> {
    const action = this.actionDef(name);
    if ((action.kind ?? 'row') !== 'row') throw new BadRequestException(`${action.label} works on many records: POST /actions/${name}`);
    let result: unknown;
    await this.inTx(outer, async (t) => {
      const row = await this.findOne(ctx, id, t, true, action.onDeleted === true);
      const c = this.rowContext<unknown>(name, ctx, t, row, { ...row.get({ plain: true }) } as Attrs, input);
      c.dto = await this.actionInput(action, input, c.issues);
      this.startState(action, row, c.issues).throwIfFailed(`${action.label} is not possible`);

      await this.runSteps(c, input.confirm === true, async () => action.run?.(c), {
        failMessage: `${action.label} is not possible`,
        builtIn: this.actionChecks(action),
      });
      await this.record(t, ctx, id, `action:${action.name}`, this.snapshot(input));
      result = c.result;
    });
    // `restore` brings the row back, so it is read normally; any other action on a deleted row reads it as deleted.
    return result !== undefined ? result : this.get(ctx, id, outer, { deleted: action.onDeleted === true && name !== 'restore' });
  }

  /** `POST /actions/:name`: a `bulk` action on `body.ids`, or a `collection` action. */
  async performAction(ctx: ReqCtx<U>, name: string, body: Record<string, unknown> = {}, outer?: Transaction): Promise<unknown> {
    const action = this.actionDef(name);
    const { ids, ...input } = body;
    if (action.kind === 'bulk') {
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => Number.isInteger(id))) {
        throw new BadRequestException('ids: choose at least one record');
      }
      return this.performMany(ctx, action, [...new Set(ids as number[])], input, outer);
    }
    if (action.kind === 'collection') return this.performCollection(ctx, action, input, outer);
    throw new BadRequestException(`${action.label} works on one record: POST /:id/actions/${name}`);
  }

  /**
   * Bulk: every chosen record is locked and checked first, and ALL their blockers come back
   * together, each naming its record. Only when none is blocked do the before/main/after phases
   * run, record by record, in the one transaction.
   */
  private async performMany(ctx: ReqCtx<U>, action: EntityAction<M, U>, ids: number[], input: Record<string, unknown>, outer?: Transaction) {
    let results: unknown[] = [];
    await this.inTx(outer, async (t) => {
      const rows = await this.model.findAll({
        where: { [Op.and]: [this.scopeWhere(ctx), { id: { [Op.in]: ids } }] } as WhereOptions,
        order: [['id', 'ASC']],
        transaction: t,
        lock: t.LOCK.UPDATE,
        ...(action.onDeleted ? { paranoid: false } : {}),
      });
      if (rows.length !== ids.length) throw new NotFoundException(`${this.label} not found`);

      const contexts = rows.map((row) => this.rowContext<unknown>(action.name, ctx, t, row, { ...row.get({ plain: true }) } as Attrs, input, rows));
      const all = new Issues();
      for (const c of contexts) {
        c.dto = await this.actionInput(action, input, c.issues);
        if (this.startState(action, c.row, c.issues).failed === false) {
          await runBuiltInChecks(c, this.actionChecks(action));
          await this.runPhase(c, 'check');
        }
        const label = String(c.row.get('name') ?? c.row.get('code') ?? `#${c.row.get('id')}`);
        const rowId = c.row.get('id') as number;
        for (const [field, messages] of Object.entries(c.issues.fields)) for (const m of messages) all.block('field', `${label}: ${field}: ${m}`, { rowId });
        for (const b of c.issues.blockers) all.block(b.code, `${label}: ${b.message}`, { ...(b.count ? { count: b.count } : {}), ...(b.refType ? { refType: b.refType } : {}), rowId });
        for (const w of c.issues.warnings) all.warn(w.code, `${label}: ${w.message}`, { ...(w.count ? { count: w.count } : {}), rowId });
      }
      all.throwIfFailed(`${action.label} is not possible for ${new Set(all.blockers.map((b) => b.rowId)).size} of ${rows.length} record(s)`);
      all.throwIfUnconfirmed(input.confirm === true);

      results = [];
      for (const c of contexts) {
        await this.runPhase(c, 'before');
        await this.runMain(c, async () => action.run?.(c));
        await this.runPhase(c, 'after');
        await this.record(t, ctx, c.row.get('id') as number, `action:${action.name}`, { ...this.snapshot(input), bulk: ids.length });
        if (c.result !== undefined) results.push(c.result);
      }
    });
    return results.length ? results : { ids, done: ids.length };
  }

  private async performCollection(ctx: ReqCtx<U>, action: EntityAction<M, U>, input: Record<string, unknown>, outer?: Transaction) {
    let result: unknown;
    await this.inTx(outer, async (t) => {
      const c: CollectionContext<Attrs, unknown, U> = { ...makeOpBase(this.opEnv(), action.name, ctx, t), dto: input };
      c.dto = await this.actionInput(action, input, c.issues);
      await this.runSteps(c, input.confirm === true, async () => action.runCollection?.(c), { failMessage: `${action.label} is not possible` });
      await this.record(t, ctx, 0, `action:${action.name}`, this.snapshot(input));
      result = c.result;
    });
    return result !== undefined ? result : { done: true };
  }

  // ---- history and flow ---------------------------------------------------------------

  /** Everything that happened to one row, newest first: who, what, which fields changed. */
  async history(ctx: ReqCtx<U>, id: number) {
    await this.findOne(ctx, id, undefined, false, this.softDelete);
    return this.historyRows(ctx, id);
  }

  /** Every operation with its steps in run order, for the generated flow document. */
  describeFlow(): EntityFlow {
    return describeEntityFlow<M>({
      ops: this.ops,
      model: this.model,
      resource: this.resource,
      label: this.label,
      dependents: this.dependents,
      actions: this.actionList,
      limits: this.limits,
      guards: this.guards.map((guard) => (guard.describe ? `${guard.id}: ${guard.describe}` : guard.id)),
      scopes: [...this.scopeMap.keys()],
      softDelete: this.softDelete,
      actionPermission: (action) => this.actionPermission(action),
      permission: (action) => this.permission(action),
    });
  }

  // ---- internals -----------------------------------------------------------------------

  private opEnv() {
    return { resource: this.resource, moduleRef: this.moduleRef, logger: this.logger, plane: this.opPlane() };
  }

  private rowContext<D>(op: string, ctx: ReqCtx<U>, t: Transaction, row: M, before: Attrs | null, dto: D, rows?: M[]): OpContext<M, Attrs, D, U> {
    const base = makeOpBase(this.opEnv(), op, ctx, t);
    // Helpers read `c.row`, not `row`: a step may replace the row and every later step, the main change and the audit follow.
    const c: OpContext<M, Attrs, D, U> = {
      ...base,
      row,
      before,
      dto,
      rows,
      changed: (field) => before === null || String(before[field] ?? '') !== String(c.row.get(field) ?? ''),
      unique: async (field) => {
        const value = c.row.get(field);
        if (value === undefined || value === null || value === '') return;
        const where: WhereOptions[] = [{ [field]: value } as WhereOptions];
        const pinned = this.pin(ctx);
        if (pinned) where.push(pinned);
        if (c.row.get('id')) where.push({ id: { [Op.ne]: c.row.get('id') } } as WhereOptions);
        if (await this.model.count({ where: { [Op.and]: where } as WhereOptions, transaction: t })) {
          base.issues.field(field, `${this.label} with this ${field} already exists`);
        }
      },
      reload: async () => c.row.reload({ transaction: t }),
    };
    return c;
  }

  /** Blocks when the record is not in a state the action starts from. */
  private startState(action: EntityAction<M, U>, row: M, issues: Issues): Issues {
    const reason = startStateReason(action, row);
    if (reason) issues.block('state', reason);
    return issues;
  }

  /** The action's input: required fields, then the DTO class if it has one. Returns what steps get as `c.dto`. */
  private async actionInput(action: EntityAction<M, U>, input: Record<string, unknown>, issues: Issues): Promise<unknown> {
    for (const field of action.inputs ?? []) {
      const given = input[field.id];
      if (field.required && (given === undefined || given === null || String(given).trim() === '')) {
        issues.field(field.id, `${field.label} is required`);
      }
    }
    if (!action.input) return input;
    const instance = plainToInstance(action.input, input, { enableImplicitConversion: true });
    for (const [field, messages] of Object.entries(flattenValidationErrors(await validate(instance, { forbidUnknownValues: false })))) {
      for (const message of messages) issues.field(field, message);
    }
    return instance;
  }

  /** built-in checks -> check steps -> report issues -> confirmation -> before steps -> main change -> after steps. */
  private async runSteps(
    c: OpBase<Attrs, U>,
    confirmed: boolean,
    main: () => Promise<unknown>,
    options: { failMessage?: string; builtIn?: BuiltInChecks<M> } = {},
  ): Promise<void> {
    // Every write while the steps run (the main change, flows, code, services they call) passes the
    // row guards of the model written and stays inside the caller's scope (see write-guard.ts).
    const applied = options.builtIn?.guards ?? this.guards;
    const access: OperationAccess = {
      ctx: c.ctx as ReqCtx<Actor>,
      can: async (code) => (await c.can(code)) !== null,
      model: this.model.name,
      scopeEnv: { partyFields: this.partyFields },
      scope: this.scopeMap.get(c.ctx.scope) as ScopeDef | undefined,
      skipGuards: this.guards.filter((guard) => !applied.includes(guard)).map((guard) => guard.id),
    };
    await runAsOperation(access, async () => {
      if (options.builtIn) await runBuiltInChecks(c as unknown as OpContext<M, Attrs, unknown, U>, options.builtIn);
      await this.runPhase(c, 'check');
      c.issues.throwIfFailed(options.failMessage);
      c.issues.throwIfUnconfirmed(confirmed);
      await this.runPhase(c, 'before');
      await this.runMain(c, main);
      await this.runPhase(c, 'after');
    });
  }

  /** The built-in main change, or the operation's `500-execute.ts` with that change as `original`. */
  private async runMain(c: OpBase<Attrs, U>, original: () => Promise<unknown>): Promise<void> {
    const execute = this.ops.execute(c.op);
    const builtIn = async () => {
      await original();
    };
    if (!execute) return builtIn();
    await this.annotate(execute, () => execute.impl.run(c as never, builtIn));
  }

  private async runPhase(c: OpBase<Attrs, U>, phase: Phase): Promise<void> {
    for (const loaded of this.ops.steps(c.op)) {
      if (loaded.phase !== phase || (loaded.impl.when && !loaded.impl.when(c as never))) continue;
      await this.runStep(loaded, c);
    }
  }

  /** One step. An unexpected error says which file it came from; `logging.steps` (or `OPS_TRACE=1`) logs every step's time. */
  private async runStep(loaded: LoadedStep, c: OpBase<Attrs, U>): Promise<void> {
    await this.annotate(loaded, () => loaded.impl[loaded.phase]!(c as never), c.op);
  }

  private async annotate(loaded: LoadedStep | LoadedExecute, work: () => Promise<void>, op?: string): Promise<void> {
    const trace = TRACE || this.frameworkOptions?.logging?.steps === true;
    const started = trace ? performance.now() : 0;
    try {
      await work();
    } catch (error) {
      if (error instanceof HttpException || !(error instanceof Error)) throw error;
      const source = this.opsDir ? sourceOf(this.opsDir, loaded.file) : loaded.file;
      if (!error.message.startsWith('[ops]')) error.message = `[ops] ${source}: ${error.message}`;
      throw error;
    }
    if (trace) this.logger.debug(`${this.resource}.${op ?? ''} ${loaded.file} ${(performance.now() - started).toFixed(1)}ms`);
  }

  private async checkDependents(row: M, t: Transaction, issues: Issues): Promise<void> {
    for (const dependent of this.dependents) {
      const extra = `${dependent.paranoid ? ' AND deleted_at IS NULL' : ''}${dependent.condition ? ` AND ${dependent.condition}` : ''}`;
      const n = await this.countWhere(t, `${dependent.table} WHERE ${dependent.column} = :id${extra}`, { id: row.get('id') });
      if (n > 0) issues.block(`used_by_${dependent.table}`, `${this.label} is used by ${n} ${dependent.label}`, { count: n, refType: dependent.table });
    }
  }

  private rejectLockedEdits(row: M, before: Attrs, locks: Record<string, string>): void {
    const issues = new Issues();
    for (const [field, reason] of Object.entries(locks)) {
      if (String(row.get(field) ?? '') !== String(before[field] ?? '')) issues.field(field, reason);
    }
    issues.throwIfFailed();
  }

  /** `{ field: [before, after] }` for every attribute that differs from `before` (works after the save, and after an execute file). */
  private diff(row: M, before: Attrs): Attrs {
    const out: Attrs = {};
    for (const key of Object.keys(this.model.getAttributes())) {
      const next = row.get(key);
      if (META.has(key) || String(before[key] ?? '') === String(next ?? '')) continue;
      out[key] = SECRET.test(key) ? '(changed)' : [before[key] ?? null, next ?? null];
    }
    return out;
  }

  private snapshot(values: Attrs): Attrs {
    return Object.fromEntries(Object.entries(values).filter(([key, value]) => !SECRET.test(key) && !META.has(key) && value !== null && value !== undefined));
  }

  /** Audit row, in the same transaction as the change. */
  protected async record(t: Transaction, ctx: ReqCtx<U>, entityId: number, event: string, data: Attrs | null) {
    await this.recordEvent(t, ctx, entityId, event, data);
  }
}

const SECRET = /password|token|secret/i;
const TRACE = process.env.OPS_TRACE === '1';
const META = new Set(['id', 'companyId', 'createdById', 'updatedById', 'createdAt', 'updatedAt', 'deletedAt', 'confirm']);
