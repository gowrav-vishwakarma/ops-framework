import { Body, Delete, Get, Inject, Param, ParseIntPipe, Patch, Post, Query, Req, type Type } from '@nestjs/common';
import type { Grant } from '../acl/acl.service.js';
import type { ReqCtx } from '../auth/auth-user.js';
import { AdminRoutes, Ctx, RequirePermission } from '../auth/decorators.js';
import { ListQueryDto } from './list-query.dto.js';
import { CRUD_ROUTE, PAYLOAD_FALLBACK } from '../payload/route-meta.js';
import { LookupQueryDto } from './lookup.js';

export interface CrudRoutes<S> {
  service: S;
  list(ctx: ReqCtx, query: ListQueryDto): Promise<unknown>;
  get(ctx: ReqCtx, id: number, actions?: string, deleted?: string): Promise<unknown>;
  create(ctx: ReqCtx, dto: object, confirm?: string): Promise<unknown>;
  update(ctx: ReqCtx, id: number, dto: object, confirm?: string): Promise<unknown>;
  remove(ctx: ReqCtx, id: number, confirm?: string): Promise<unknown>;
  actions(ctx: ReqCtx): Promise<unknown>;
  lookup(ctx: ReqCtx, name: string, query: LookupQueryDto, raw?: Record<string, unknown>): Promise<unknown>;
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

/** The caller's context with the scope, limits and scope data of another grant (an action's). */
function withGrant(ctx: ReqCtx, grant: Grant): ReqCtx {
  return { ...ctx, scope: grant.scope, limits: grant.limits, ...(grant.params ? { scopeParams: grant.params } : { scopeParams: undefined }) };
}

/**
 * The standard routes of a collection, guarded by `resource.view|create|update|delete`: a tenant's
 * (`TenantCrudService`) or, with `plane: 'control'`, the admin panel's (`ControlCrudService`).
 * Extend the returned class under `@Controller('path')` and add module routes beside them.
 */
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

    /** A lookup (a picker in a form): any member of the company; the service applies the lookup's own rules. */
    @Get('lookups/:name')
    lookup(@Ctx() ctx: ReqCtx, @Param('name') name: string, @Query() query: LookupQueryDto, @Req() req: { query?: Record<string, unknown> }) {
      // The lookup's named parameters are the query's other keys (the DTO keeps only the common ones).
      return (this.service as AnyService).lookup(ctx, name, query, req.query ?? {});
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
      return (this.service as AnyService).create(ctx, this.body('create', dto, options.create), undefined, confirm === 'true');
    }

    /**
     * The body of a create or update: an operation with its own `dto.ts` is checked by the service (every caller); one
     * without is held here to the class the controller was built with, in the same strictness.
     */
    protected body(op: 'create' | 'update', dto: object, fallback: Type<object>): object {
      const service = this.service as AnyService;
      return service.hasPayloadDto(op) ? dto : service.checkedPayload(op, dto, fallback);
    }

    @Patch(':id')
    @RequirePermission(resource, 'update')
    update(@Ctx() ctx: ReqCtx, @Param('id', ParseIntPipe) id: number, @Body() dto: object, @Query('confirm') confirm?: string) {
      return (this.service as AnyService).update(ctx, id, this.body('update', dto, options.update), undefined, confirm === 'true');
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
  Reflect.defineMetadata('design:paramtypes', [Object, String, LookupQueryDto, Object], proto, 'lookup');
  // Bodies typed Object: the global pipe leaves them, `body()` holds them to their class (or the operation's dto.ts).
  Reflect.defineMetadata('design:paramtypes', [Object, Object, String], proto, 'create');
  Reflect.defineMetadata('design:paramtypes', [Object, Number, String, Object], proto, 'act');
  Reflect.defineMetadata('design:paramtypes', [Object, Number], proto, 'history');
  Reflect.defineMetadata('design:paramtypes', [Object, Number, String, String], proto, 'get');
  Reflect.defineMetadata('design:paramtypes', [Object, Number, String], proto, 'view');
  Reflect.defineMetadata('design:paramtypes', [Object, String, Object], proto, 'actAll');
  Reflect.defineMetadata('design:paramtypes', [Object, Number, Object, String], proto, 'update');
  // For the contract: the classes behind the Object-typed bodies, and the routes that expand per operation.
  Reflect.defineMetadata(PAYLOAD_FALLBACK, options.create, proto, 'create');
  Reflect.defineMetadata(PAYLOAD_FALLBACK, options.update, proto, 'update');
  for (const kind of ['create', 'update', 'list', 'act', 'actAll', 'view', 'lookup'] as const) Reflect.defineMetadata(CRUD_ROUTE, kind, proto, kind);

  if (options.plane === 'control') AdminRoutes()(CrudBase);
  return CrudBase as unknown as Type<CrudRoutes<S>>;
}

interface AnyService {
  lookup(ctx: ReqCtx, name: string, query: LookupQueryDto, raw?: Record<string, unknown>): Promise<unknown>;
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
  hasPayloadDto(op: string): boolean;
  checkedPayload<T>(op: string, payload: T, fallback?: Type<object>): T;
}

export interface LookupRoutes<S> {
  service: S;
  lookup(ctx: ReqCtx, name: string, query: LookupQueryDto, raw?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Only the lookups of a collection (`GET lookups/:name`): a master the forms pick from but nobody keeps from
 * this app (states, currencies). The service is a CRUD service; its other routes are not offered. `plane: 'control'`:
 * an admin-panel collection's lookups (`ControlCrudService`), admin tokens only.
 */
export function lookupController<S extends object>(options: { service: Type<S>; plane?: 'tenant' | 'control' }): Type<LookupRoutes<S>> {
  abstract class LookupBase {
    @Inject(options.service) readonly service: S;

    @Get('lookups/:name')
    lookup(@Ctx() ctx: ReqCtx, @Param('name') name: string, @Query() query: LookupQueryDto, @Req() req: { query?: Record<string, unknown> }) {
      return (this.service as AnyService).lookup(ctx, name, query, req.query ?? {});
    }
  }
  Reflect.defineMetadata('design:paramtypes', [Object, String, LookupQueryDto, Object], LookupBase.prototype, 'lookup');
  if (options.plane === 'control') AdminRoutes()(LookupBase);
  return LookupBase as unknown as Type<LookupRoutes<S>>;
}
