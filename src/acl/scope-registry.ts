import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { ModelStatic, WhereOptions } from 'sequelize';
import type { Model } from 'sequelize-typescript';
import type { ReqCtx } from '../auth/auth-user.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { BUILT_IN_SCOPES, type ScopeDef } from './scopes.js';

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

  /** The caller's scope as a condition on `model`, or null for no limit. An unknown scope denies. */
  where(ctx: ReqCtx, model: ModelStatic<Model>): WhereOptions | null {
    const scope = this.scopes.get(ctx.scope);
    if (!scope) throw new ForbiddenException(`Unknown access scope "${ctx.scope}"`);
    return scope.where(ctx, model as never, { partyFields: [] });
  }
}
