import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Transaction } from 'sequelize';
import type { Model, ModelCtor } from 'sequelize-typescript';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { currentTenant } from '../tenancy/context.js';
import { PARTITION } from '../tenancy/partition.js';

/**
 * A cache the project keeps of database rows (a company's context in Redis, a permission set in memory) and the models
 * whose writes make it stale. The framework watches those models: after the transaction that wrote them commits (at
 * once for a write without one), `clear` runs once with every company the transaction touched. Only caches the reader
 * rebuilds from the database on a miss belong here: a signed-in session is not a cache (dropping it signs the user
 * out), so revoking one stays an explicit step of the action that means it.
 */
export interface CacheRule {
  /** Names it in logs: `company-context`. */
  id: string;
  /** Model names (tenant or control) whose create, update, upsert or delete makes the cache stale. */
  models: readonly string[];
  /** The company a written row belongs to; default its partition field, else the request's company. */
  companyOf?(row: Record<string, unknown>, model: string): number | null | undefined;
  /** Drops the cache for these companies; `get` resolves the project's services. A failure is logged, never thrown. */
  clear(companyIds: readonly number[], get: <T>(token: unknown) => T): Promise<void> | void;
}

type Pending = Map<CacheRule, Set<number>>;

const PENDING = new WeakMap<Transaction, Pending>();

/** The outermost transaction: a savepoint's work is kept only when the outer one commits. */
function root(t: Transaction): Transaction {
  let current = t as Transaction & { parent?: Transaction };
  while (current.parent) current = current.parent as Transaction & { parent?: Transaction };
  return current;
}

/** Runs the project's cache rules after the writes that make them stale (`options.cacheRules`). */
@Injectable()
export class CacheRules implements OnModuleInit {
  private static current: CacheRules | undefined;
  private readonly logger = new Logger(CacheRules.name);
  private readonly byModel = new Map<string, CacheRule[]>();
  /** Writes without a transaction: cleared together on the next tick (a bulk statement fires once per row). */
  private loose: Pending | null = null;

  constructor(
    private readonly moduleRef: ModuleRef,
    @Optional() @Inject(FRAMEWORK_OPTIONS) options?: FrameworkOptions,
  ) {
    for (const rule of options?.cacheRules ?? []) {
      for (const model of rule.models) this.byModel.set(model, [...(this.byModel.get(model) ?? []), rule]);
    }
  }

  onModuleInit(): void {
    CacheRules.current = this;
  }

  static get instance(): CacheRules | undefined {
    return CacheRules.current;
  }

  watches(model: string): boolean {
    return this.byModel.has(model);
  }

  /** A row of `model` was written (in `t` when given). */
  written(model: string, rows: readonly Model[], t: Transaction | undefined, where?: unknown): void {
    const rules = this.byModel.get(model);
    if (!rules) return;
    const pending = this.pendingFor(t);
    const fromWhere = companyIn(where);
    const request = Number(currentTenant()?.ref.companyId);
    for (const rule of rules) {
      const companies = pending.get(rule) ?? new Set<number>();
      pending.set(rule, companies);
      // A bulk update or delete without per-row hooks: the company its condition names, else the request's.
      const found = rows.length ? rows.map((row) => companyOfRow(rule, model, row)) : [fromWhere];
      for (const id of found) {
        const company = Number(id ?? request);
        if (Number.isInteger(company) && company > 0) companies.add(company);
      }
    }
  }

  private pendingFor(t: Transaction | undefined): Pending {
    if (!t) {
      if (!this.loose) {
        this.loose = new Map();
        setImmediate(() => {
          const work = this.loose;
          this.loose = null;
          if (work) void this.flush(work);
        });
      }
      return this.loose;
    }
    const outer = root(t);
    let pending = PENDING.get(outer);
    if (!pending) {
      pending = new Map();
      PENDING.set(outer, pending);
      const work = pending;
      outer.afterCommit(() => this.flush(work));
    }
    return pending;
  }

  private async flush(pending: Pending): Promise<void> {
    const get = <T>(token: unknown) => this.moduleRef.get<T>(token as never, { strict: false });
    await Promise.all(
      [...pending].map(async ([rule, companies]) => {
        if (companies.size === 0) return;
        try {
          await rule.clear([...companies], get);
        } catch (error) {
          this.logger.warn(`Cache rule ${rule.id} failed for companies ${[...companies].join(', ')}: ${String(error)}`);
        }
      }),
    );
  }
}

function companyOfRow(rule: CacheRule, model: string, row: Model): unknown {
  const plain = (row.get?.({ plain: true }) ?? row) as Record<string, unknown>;
  return rule.companyOf ? rule.companyOf(plain, model) : plain[PARTITION.field];
}

/** The company a bulk update or delete names in its condition (`{ companyId: 7, … }`), when it names one. */
function companyIn(where: unknown): number | null {
  if (!where || typeof where !== 'object') return null;
  const value = (where as Record<string, unknown>)[PARTITION.field];
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

type HookOptions = { transaction?: Transaction; where?: unknown; individualHooks?: boolean };

/** Hooks on one model the rules watch: every create, update, upsert and delete reports to `CacheRules`. */
export function installCacheRuleHooks(model: ModelCtor<Model>): void {
  const report = (rows: readonly Model[], options: HookOptions) => {
    const rules = CacheRules.instance;
    if (rules?.watches(model.name)) rules.written(model.name, rows, options?.transaction, options?.where);
  };
  model.addHook('afterCreate', 'framework:cache-rules-create', ((row: Model, options: HookOptions) => report([row], options)) as never);
  model.addHook('afterUpdate', 'framework:cache-rules-update', ((row: Model, options: HookOptions) => report([row], options)) as never);
  model.addHook('afterDestroy', 'framework:cache-rules-destroy', ((row: Model, options: HookOptions) => report([row], options)) as never);
  model.addHook('afterUpsert', 'framework:cache-rules-upsert', (([row]: [Model], options: HookOptions) => report(row ? [row] : [], options)) as never);
  model.addHook('afterBulkCreate', 'framework:cache-rules-bulk-create', ((rows: Model[], options: HookOptions) => report(rows, options)) as never);
  // A bulk update or delete without per-row hooks names its rows only by its condition.
  const bulk = (options: HookOptions) => {
    if (!options?.individualHooks) report([], options);
  };
  model.addHook('afterBulkUpdate', 'framework:cache-rules-bulk-update', bulk as never);
  model.addHook('afterBulkDestroy', 'framework:cache-rules-bulk-destroy', bulk as never);
}
