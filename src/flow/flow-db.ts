import { Injectable, InternalServerErrorException, UnprocessableEntityException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Op, type Transaction, type WhereOptions } from 'sequelize';
import type { Model, ModelCtor } from 'sequelize-typescript';
import { ScopeRegistry } from '../acl/scope-registry.js';
import type { Actor, ReqCtx } from '../auth/auth-user.js';
import { preparedFor, RowGuardRegistry } from '../crud/row-guard.js';
import { currentTenant } from '../tenancy/context.js';
import { sequelizeOf } from '../tenancy/guards.js';

export type Row = Record<string, unknown>;

/**
 * Who a data step acts for. Every read and write of a flow is limited the way the operation is:
 *  - the tenant: always (the models pin the company and the schema; there is no raw SQL);
 *  - the caller's data scope (branch, own, the branches a grant names): unless the step says
 *    `asSystem: true`, which the flow document shows;
 *  - the row guards of the model written (period lock...): always, as for that model's own writes.
 */
export interface FlowAccess {
  ctx: ReqCtx<Actor>;
  /** `asSystem: true` on the step: the caller's data scope does not limit it. */
  system: boolean;
  can(code: string): Promise<boolean>;
}

/**
 * The data operations flow steps use, by model name, inside the operation's transaction. The
 * framework's implementation goes through the tenant's models; tests give
 * `fakeOpContext({ services: [[FlowDb, fake]] })`.
 */
export abstract class FlowDb {
  abstract hasModel(model: string): boolean;
  abstract findOne(t: Transaction, access: FlowAccess, model: string, where: Row, attributes?: string[]): Promise<Row | null>;
  abstract findAll(t: Transaction, access: FlowAccess, model: string, where: Row, options?: { attributes?: string[]; limit?: number }): Promise<Row[]>;
  abstract count(t: Transaction, access: FlowAccess, model: string, where: WhereOptions): Promise<number>;
  abstract create(t: Transaction, access: FlowAccess, model: string, values: Row): Promise<Row>;
  abstract update(t: Transaction, access: FlowAccess, model: string, values: Row, where: Row): Promise<number>;
  abstract destroy(t: Transaction, access: FlowAccess, model: string, where: Row): Promise<number>;
}

/** Hard cap on rows a flow step may load or change at once. */
export const FLOW_ROW_LIMIT = 5_000;

/** A plain row with the `get` a guard calls on a model instance. */
const asRow = (values: Row): Model => ({ ...values, get: (key: string) => values[key] }) as unknown as Model;

const refused = (message: string, code: string, refType?: string) =>
  new UnprocessableEntityException({ message, errors: {}, blockers: [{ code, message, ...(refType ? { refType } : {}) }] });

@Injectable()
export class SequelizeFlowDb extends FlowDb {
  constructor(
    private readonly scopes: ScopeRegistry,
    private readonly guards: RowGuardRegistry,
    private readonly moduleRef: ModuleRef,
  ) {
    super();
  }

  private model(name: string, t?: Transaction): ModelCtor<Model> {
    const sequelize = t ? sequelizeOf(t) : currentTenant()?.sequelize;
    const model = sequelize?.models[name] as ModelCtor<Model> | undefined;
    if (!model) throw new InternalServerErrorException(`Flow: unknown model "${name}"`);
    return model;
  }

  hasModel(name: string): boolean {
    try {
      return Boolean(this.model(name));
    } catch {
      return false;
    }
  }

  /** `where` limited to the caller's scope on this model (unless the step acts as the system). */
  private scoped(access: FlowAccess, model: ModelCtor<Model>, where: WhereOptions): WhereOptions {
    if (access.system) return where;
    const scope = this.scopes.where(access.ctx as ReqCtx, model);
    return scope ? ({ [Op.and]: [where, scope] } as WhereOptions) : where;
  }

  /** The model's row guards for one row; the first refusal stops the write with 422. */
  private async guard(t: Transaction, access: FlowAccess, model: string, op: 'create' | 'update' | 'delete', row: Model, before: Row | null): Promise<void> {
    const get = <T>(token: unknown) => this.moduleRef.get<T>(token as never, { strict: false });
    for (const guard of this.guards.for(model)) {
      const prepared = await preparedFor(guard, access.ctx as never, get, t);
      const reason = await guard.reason({ op, row, before, ctx: access.ctx as never, prepared, can: access.can });
      if (reason) throw refused(reason, guard.code ?? guard.id, model);
    }
  }

  async findOne(t: Transaction, access: FlowAccess, model: string, where: Row, attributes?: string[]): Promise<Row | null> {
    const m = this.model(model, t);
    return (await m.findOne({ where: this.scoped(access, m, where as WhereOptions), ...(attributes ? { attributes } : {}), raw: true, transaction: t })) as Row | null;
  }

  async findAll(t: Transaction, access: FlowAccess, model: string, where: Row, options: { attributes?: string[]; limit?: number } = {}): Promise<Row[]> {
    const m = this.model(model, t);
    const limit = Math.min(options.limit ?? FLOW_ROW_LIMIT, FLOW_ROW_LIMIT);
    return (await m.findAll({ where: this.scoped(access, m, where as WhereOptions), ...(options.attributes ? { attributes: options.attributes } : {}), limit, raw: true, transaction: t })) as unknown as Row[];
  }

  count(t: Transaction, access: FlowAccess, model: string, where: WhereOptions): Promise<number> {
    const m = this.model(model, t);
    return m.count({ where: this.scoped(access, m, where), transaction: t });
  }

  async create(t: Transaction, access: FlowAccess, model: string, values: Row): Promise<Row> {
    const m = this.model(model, t);
    const row = m.build(values as never);
    // A new row must fall inside the caller's scope: a branch-limited user cannot create for another branch.
    if (!access.system) this.assertInScope(access, m, row.get({ plain: true }) as Row);
    await this.guard(t, access, model, 'create', row, null);
    return (await row.save({ transaction: t })).get({ plain: true }) as Row;
  }

  async update(t: Transaction, access: FlowAccess, model: string, values: Row, where: Row): Promise<number> {
    const m = this.model(model, t);
    const rows = await this.affected(t, access, m, where);
    for (const before of rows) {
      const after = { ...before, ...values };
      // Moving a row out of the caller's scope (to another branch) is refused like creating it there.
      if (!access.system) this.assertInScope(access, m, after);
      await this.guard(t, access, model, 'update', asRow(after), before);
    }
    if (!rows.length) return 0;
    // Instance hooks (audit, partition) run per row, as for any write through the models.
    const [count] = await m.update(values as never, { where: { id: { [Op.in]: rows.map((r) => r.id) } } as WhereOptions, transaction: t, individualHooks: true });
    return count;
  }

  async destroy(t: Transaction, access: FlowAccess, model: string, where: Row): Promise<number> {
    const m = this.model(model, t);
    const rows = await this.affected(t, access, m, where);
    for (const before of rows) await this.guard(t, access, model, 'delete', asRow(before), before);
    if (!rows.length) return 0;
    return m.destroy({ where: { id: { [Op.in]: rows.map((r) => r.id) } } as WhereOptions, transaction: t, individualHooks: true });
  }

  /** The rows a write would touch, inside the scope; more than the cap is refused, never truncated. */
  private async affected(t: Transaction, access: FlowAccess, m: ModelCtor<Model>, where: Row): Promise<Row[]> {
    const rows = (await m.findAll({ where: this.scoped(access, m, where as WhereOptions), limit: FLOW_ROW_LIMIT + 1, raw: true, transaction: t })) as unknown as Row[];
    if (rows.length > FLOW_ROW_LIMIT) throw new InternalServerErrorException(`Flow: a write to ${m.name} would change more than ${FLOW_ROW_LIMIT} rows`);
    return rows;
  }

  /** The scope's own row rule when it has one (`allows`), else its equality / IN conditions, on new values. */
  private assertInScope(access: FlowAccess, m: ModelCtor<Model>, values: Row): void {
    const scope = this.scopes.where(access.ctx as ReqCtx, m);
    if (!scope) return;
    for (const [field, condition] of Object.entries(scope as Record<string, unknown>)) {
      if (!(field in values)) continue;
      const allowed = condition && typeof condition === 'object' ? ((condition as Record<symbol, unknown>)[Op.in] as unknown[] | undefined) : [condition];
      if (allowed && !allowed.map(String).includes(String(values[field]))) throw refused(`Outside your access scope (${field})`, 'out_of_scope', m.name);
    }
  }
}
