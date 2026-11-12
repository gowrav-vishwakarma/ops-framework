import { Body, Delete, Get, Inject, Param, ParseIntPipe, Patch, Post, Query, type Type } from '@nestjs/common';
import type { Grant } from '../acl/acl.service.js';
import type { ReqCtx } from '../auth/auth-user.js';
import { AdminRoutes, Ctx, RequirePermission } from '../auth/decorators.js';
import { ListQueryDto } from './list-query.dto.js';

export interface CrudRoutes<S> {
  service: S;
  list(ctx: ReqCtx, query: ListQueryDto): Promise<unknown>;
  get(ctx: ReqCtx, id: number, actions?: string, deleted?: string): Promise<unknown>;
  create(ctx: ReqCtx, dto: object, confirm?: string): Promise<unknown>;
  update(ctx: ReqCtx, id: number, dto: object, confirm?: string): Promise<unknown>;
  remove(ctx: ReqCtx, id: number, confirm?: string): Promise<unknown>;
  actions(ctx: ReqCtx): Promise<unknown>;
  history(ctx: ReqCtx, id: number): Promise<unknown>;
  view(ctx: ReqCtx, id: number, name: string): Promise<unknown>;
  actAll(ctx: ReqCtx, name: string, body: Record<string, unknown>): Promise<unknown>;
  act(ctx: ReqCtx, id: number, name: string, input: Record<string, unknown>): Promise<unknown>;
}

interface CrudOptions<S> {
  /** Permission resource, such as `vehicle`. */
  resource: string;
  service: Type<S>;
  create: Type<object>;
  update: Type<object>;
  /** Query DTO with module filters; defaults to the plain list query. */
  query?: Type<ListQueryDto>;
  /** `control`: an admin-panel collection (`ControlCrudService`), reachable with admin tokens only. */
  plane?: 'tenant' | 'control';
}

/**
 * The standard routes of a collection, guarded by `resource.view|create|update|delete`: a tenant's
 * (`TenantCrudService`) or, with `plane: 'control'`, the admin panel's (`ControlCrudService`).
 * Extend the returned class under `@Controller('path')` and add module routes beside them.
 */
/** The caller's context with the scope, limits and scope data of another grant (an action's). */
function withGrant(ctx: ReqCtx, grant: Grant): ReqCtx {
  return { ...ctx, scope: grant.scope, limits: grant.limits, ...(grant.params ? { scopeParams: grant.params } : { scopeParams: undefined }) };
}

export function crudController<S extends object>(
  options: CrudOptions<S>,
): Type<CrudRoutes<S>> {
  const { resource } = options;

  abstract class CrudBase {
    @Inject(options.service) readonly service: S;

    /** Named actions this caller may run (`activate`, `deactivate`, ...), with their allowed-from state. */
    @Get('actions')
    @RequirePermission(resource, 'list')
    actions(@Ctx() ctx: ReqCtx) {
      return (this.service as AnyService).allowedActions(ctx);
    }

    /** Run one named action. Needs its own permission, checked here against the caller's scope. */
    @Post(':id/actions/:name')
    @RequirePermission(resource, 'view')
    async act(
      @Ctx() ctx: ReqCtx,
      @Param('id', ParseIntPipe) id: number,
      @Param('name') name: string,
      @Body() input: Record<string, unknown>,
    ) {
      const service = this.service as AnyService;
      const grant = await this.grantOf(ctx, service.actionPermission(service.actionDef(name)));
      return service.perform(withGrant(ctx, grant), id, name, input ?? {});
    }

    /** The scope and limits the caller holds for `code`, or 403. */
    protected grantOf(ctx: ReqCtx, code: string): Promise<Grant> {
      return (this.service as AnyService).grantOf(ctx, code);
    }

    /** A named read of one record: print data, usage summary... Defined by `ops/view-<name>/`. */
    @Get(':id/views/:name')
    @RequirePermission(resource, 'view')
    view(@Ctx() ctx: ReqCtx, @Param('id', ParseIntPipe) id: number, @Param('name') name: string) {
      return (this.service as AnyService).view(ctx, id, name);
    }

    /** A `bulk` action on `{ ids }` or a `collection` action (import, recalculation). */
    @Post('actions/:name')
    @RequirePermission(resource, 'view')
    async actAll(@Ctx() ctx: ReqCtx, @Param('name') name: string, @Body() body: Record<string, unknown>) {
      const service = this.service as AnyService;
      const grant = await this.grantOf(ctx, service.actionPermission(service.actionDef(name)));
      return service.performAction(withGrant(ctx, grant), name, body ?? {});
    }

    @Get()
    @RequirePermission(resource, 'list')
    list(@Ctx() ctx: ReqCtx, @Query() query: ListQueryDto) {
      return (this.service as AnyService).list(ctx, query);
    }

    /** Everything that happened to one row: created, edited (which fields), actions, by whom. */
    @Get(':id/history')
    @RequirePermission(resource, 'view')
    history(@Ctx() ctx: ReqCtx, @Param('id', ParseIntPipe) id: number) {
      return (this.service as AnyService).history(ctx, id);
    }

    @Get(':id')
    @RequirePermission(resource, 'view')
    get(
      @Ctx() ctx: ReqCtx,
      @Param('id', ParseIntPipe) id: number,
      @Query('actions') actions?: string,
      @Query('deleted') deleted?: string,
    ) {
      return (this.service as AnyService).get(ctx, id, undefined, { actions: actions === '1', deleted: deleted === '1' });
    }

    @Post()
    @RequirePermission(resource, 'create')
    create(@Ctx() ctx: ReqCtx, @Body() dto: object, @Query('confirm') confirm?: string) {
      return (this.service as AnyService).create(ctx, dto, undefined, confirm === 'true');
    }

    @Patch(':id')
    @RequirePermission(resource, 'update')
    update(@Ctx() ctx: ReqCtx, @Param('id', ParseIntPipe) id: number, @Body() dto: object, @Query('confirm') confirm?: string) {
      return (this.service as AnyService).update(ctx, id, dto, undefined, confirm === 'true');
    }

    @Delete(':id')
    @RequirePermission(resource, 'delete')
    remove(@Ctx() ctx: ReqCtx, @Param('id', ParseIntPipe) id: number, @Query('confirm') confirm?: string) {
      return (this.service as AnyService).remove(ctx, id, undefined, confirm === 'true');
    }
  }

  // The DTO classes differ per module, so the validation pipe is told them here.
  const proto = CrudBase.prototype;
  Reflect.defineMetadata('design:paramtypes', [Object, options.query ?? ListQueryDto], proto, 'list');
  Reflect.defineMetadata('design:paramtypes', [Object, options.create, String], proto, 'create');
  Reflect.defineMetadata('design:paramtypes', [Object, Number, String, Object], proto, 'act');
  Reflect.defineMetadata('design:paramtypes', [Object, Number], proto, 'history');
  Reflect.defineMetadata('design:paramtypes', [Object, Number, String, String], proto, 'get');
  Reflect.defineMetadata('design:paramtypes', [Object, Number, String], proto, 'view');
  Reflect.defineMetadata('design:paramtypes', [Object, String, Object], proto, 'actAll');
  Reflect.defineMetadata('design:paramtypes', [Object, Number, options.update, String], proto, 'update');

  if (options.plane === 'control') AdminRoutes()(CrudBase);
  return CrudBase as unknown as Type<CrudRoutes<S>>;
}

interface AnyService {
  allowedActions(ctx: ReqCtx): Promise<unknown>;
  grantOf(ctx: ReqCtx, code: string): Promise<Grant>;
  list(ctx: ReqCtx, query: ListQueryDto): Promise<unknown>;
  get(ctx: ReqCtx, id: number, t?: undefined, options?: { actions?: boolean; deleted?: boolean }): Promise<unknown>;
  create(ctx: ReqCtx, dto: object, t?: undefined, confirmed?: boolean): Promise<unknown>;
  update(ctx: ReqCtx, id: number, dto: object, t?: undefined, confirmed?: boolean): Promise<unknown>;
  remove(ctx: ReqCtx, id: number, t?: undefined, confirmed?: boolean): Promise<unknown>;
  history(ctx: ReqCtx, id: number): Promise<unknown>;
  describeActions(): Array<{ permission: string }>;
  actionDef(name: string): unknown;
  actionPermission(action: unknown): string;
  perform(ctx: ReqCtx, id: number, name: string, input: Record<string, unknown>): Promise<unknown>;
  performAction(ctx: ReqCtx, name: string, body: Record<string, unknown>): Promise<unknown>;
  view(ctx: ReqCtx, id: number, name: string): Promise<unknown>;
}
