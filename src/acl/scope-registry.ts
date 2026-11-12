import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { ModelStatic, WhereOptions } from 'sequelize';
import type { Model } from 'sequelize-typescript';
import type { ReqCtx } from '../auth/auth-user.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { BUILT_IN_SCOPES, scopeWriteRule, type ScopeDef, type ScopeEnv } from './scopes.js';

/**
 * Every data scope by id (built-in plus `options.scopes`), for code that applies the caller's scope
 * to a model the request did not open (flow steps reading or writing related rows).
 */
@Injectable()
export class ScopeRegistry {
  private readonly scopes = new Map<string, ScopeDef>();

  constructor(@Inject(FRAMEWORK_OPTIONS) options: FrameworkOptions) {
    for (const scope of [...BUILT_IN_SCOPES, ...(options.scopes ?? [])]) this.scopes.set(scope.id, scope as ScopeDef);
  }

  byId(id: string): ScopeDef | undefined {
    return this.scopes.get(id);
  }

  /**
   * The caller's scope as a condition on `model`, or null for no limit. An unknown scope denies.
   * With `operationModel` (inside an operation), another model gets only a `related` scope.
   */
  where(ctx: ReqCtx, model: ModelStatic<Model>, operationModel?: string): WhereOptions | null {
    const scope = this.scopes.get(ctx.scope);
    if (!scope) throw new ForbiddenException(`Unknown access scope "${ctx.scope}"`);
    if (operationModel && operationModel !== model.name && !scope.related) return null;
    return scope.where(ctx, model as never, { partyFields: [] });
  }

  /** The row rule writes to `model` must pass, or null (see `scopeWriteRule`). `scope` is the operation's own resolved scope. */
  writeRule(ctx: ReqCtx, model: ModelStatic<Model>, own: boolean, env: ScopeEnv, scope?: ScopeDef): ((row: Model) => boolean) | null {
    return scopeWriteRule(scope ?? this.scopes.get(ctx.scope), ctx, model as never, own, env) as ((row: Model) => boolean) | null;
  }
}
