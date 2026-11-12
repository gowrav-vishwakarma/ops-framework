import { type DynamicModule, Global, type MiddlewareConsumer, Module, type NestModule, type InjectionToken, type ModuleMetadata, type OptionalFactoryDependency, type Provider, type Type } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { getModelToken, SequelizeModule } from '@nestjs/sequelize';
import { ClsModule } from 'nestjs-cls';
import { AclService } from './acl/acl.service.js';
import { PermissionMeta } from './acl/limits.js';
import { PermissionCatalogService } from './acl/permission-catalog.service.js';
import { PermissionGuard } from './acl/permission.guard.js';
import { Permission } from './acl/permission.model.js';
import { RolePermission } from './acl/role-permission.model.js';
import { Role } from './acl/role.model.js';
import { TableAclSource } from './acl/table-acl.source.js';
import { UserPermissionOverride } from './acl/user-permission-override.model.js';
import { AdminAclService, AdminPermissionMeta } from './admin/admin-acl.service.js';
import { AdminCatalogService } from './admin/admin-catalog.service.js';
import { AdminPermission } from './admin/admin-permission.model.js';
import { AdminRolePermission } from './admin/admin-role-permission.model.js';
import { AdminRole } from './admin/admin-role.model.js';
import { ControlEvent } from './admin/control-event.model.js';
import { EntityEvent } from './audit/entity-event.model.js';
import { TableAuditSink } from './audit/table-audit.sink.js';
import { JwtAuthGuard } from './auth/jwt-auth.guard.js';
import { ClusterBus, LocalBus } from './cluster/cluster-bus.js';
import { RedisBus } from './cluster/redis-bus.js';
import {
  ACL_SOURCE,
  AUDIT_SINK,
  FRAMEWORK_FEATURES,
  PLACEMENT_STORE,
  resolveFeatures,
  TOKEN_VALIDATOR,
  type FeatureImpl,
  type FrameworkFeatures,
  type ResolvedFeatures,
} from './features.js';
import { FlowDb, SequelizeFlowDb } from './flow/flow-db.js';
import { ScopeRegistry } from './acl/scope-registry.js';
import { RowGuardRegistry } from './crud/row-guard.js';
import { WriteGuard } from './crud/write-guard.js';
import { FrameworkBoot } from './framework-boot.service.js';
import { RequestLogMiddleware } from './logging/request-log.js';
import { MigrationFiles } from './migrations/migration-files.js';
import { MigrationRunner } from './migrations/migration-runner.js';
import { Notifier } from './notify/notifier.service.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from './options.js';
import { ServiceDispatcher } from './services/dispatcher.js';
import { EventOutbox } from './services/event-outbox.js';
import { EventTransport, LocalEventTransport } from './services/event-transport.js';
import { ControlInbox, TenantInbox } from './services/inbox.model.js';
import { ControlOutbox, TenantOutbox } from './services/outbox.model.js';
import { RedisStreamTransport } from './services/redis-stream-transport.js';
import { RemoteCalls } from './services/remote-calls.js';
import { ServiceClient } from './services/service-client.js';
import { ServicesController } from './services/services.controller.js';
import { ConnectionRegistry } from './tenancy/connection-registry.js';
import { TenantRouting } from './tenancy/control/tenant-routing.model.js';
import { TenantShard } from './tenancy/control/tenant-shard.model.js';
import { TenantLifecycle } from './tenancy/lifecycle.js';
import { CompanyMover } from './tenancy/move/move-company.js';
import { PlacementResolver } from './tenancy/placement.js';
import { SchemaSync } from './tenancy/schema-sync.js';
import { TablePlacementStore } from './tenancy/table-placement.store.js';
import { TenantContextGuard } from './tenancy/tenant-context.guard.js';
import { ControlPlane, TenantDb } from './tenancy/tenant-db.js';
import { TenantRunner } from './tenancy/tenant-runner.js';

/** The framework's own tables, per feature. Only the features a project turns on are registered. */
const FEATURE_MODELS = {
  acl: [Permission, Role, RolePermission, UserPermissionOverride],
  audit: [EntityEvent],
  placement: [TenantRouting, TenantShard],
  services: [ControlInbox, TenantInbox, ControlOutbox, TenantOutbox],
  admin: [AdminPermission, AdminRole, AdminRolePermission, ControlEvent],
};

/** Every model the framework can own, for tools that need the full list. */
export const FRAMEWORK_MODELS = Object.values(FEATURE_MODELS).flat();

/** Always present: tenancy, connections, sign-in verification, tenant context, permission guard. */
const CORE: Provider[] = [
  RequestLogMiddleware,
  ConnectionRegistry,
  MigrationFiles,
  PlacementResolver,
  SchemaSync,
  TenantRunner,
  TenantDb,
  ControlPlane,
  PermissionMeta,
  Notifier,
  JwtAuthGuard,
  TenantContextGuard,
  PermissionGuard,
  FrameworkBoot,
  ScopeRegistry,
  RowGuardRegistry,
  WriteGuard,
  { provide: FlowDb, useClass: SequelizeFlowDb },
];

export interface FrameworkAsyncOptions {
  imports?: ModuleMetadata['imports'];
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: never[]) => FrameworkOptions | Promise<FrameworkOptions>;
  /**
   * What the framework owns and what the project plugs in. Known when the module is built (it
   * decides which tables and providers exist), so it is not part of the async options.
   */
  features?: FrameworkFeatures;
}

/** `'tables'` registers the framework's implementation, a class the project's; both answer `token`. */
function feature<T>(token: symbol, impl: FeatureImpl<T> | undefined, table: Type<T>): Provider[] {
  if (!impl) return [];
  const useClass = impl === 'tables' ? table : impl;
  return [useClass, { provide: token, useExisting: useClass }];
}

function modelsOf(features: ResolvedFeatures) {
  return [
    ...(features.acl === 'tables' ? FEATURE_MODELS.acl : []),
    ...(features.audit === 'tables' ? FEATURE_MODELS.audit : []),
    ...(features.placement === 'tables' ? FEATURE_MODELS.placement : []),
    ...(features.services ? FEATURE_MODELS.services : []),
    ...(features.admin ? FEATURE_MODELS.admin : []),
  ];
}

/**
 * The ops framework: tenancy (partition, placement, control plane), sign-in verification, ACL with
 * scopes and limits, audit, and the operations engine. It knows nothing about what the app stores:
 * the app passes its catalog, scopes and token claims in the options and picks, per feature, the
 * framework's tables or its own implementation (`features`). Business rules (period locks,
 * financial years, document numbers, settings) are the project's: see `RowGuard`.
 *
 * Guards run in this order for every route: sign-in, tenant context, permission.
 */
@Global()
@Module({})
export class FrameworkModule implements NestModule {
  /** Request logging for every route (`FrameworkOptions.logging.http`). */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLogMiddleware).forRoutes('*path');
  }

  static forRootAsync(options: FrameworkAsyncOptions): DynamicModule {
    const features = resolveFeatures(options.features);
    const managesPlaces = features.schema === 'owned' && features.placement === 'tables';
    const providers: Provider[] = [
      { provide: FRAMEWORK_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
      { provide: FRAMEWORK_FEATURES, useValue: features },
      {
        provide: ClusterBus,
        inject: [FRAMEWORK_OPTIONS],
        useFactory: (framework: FrameworkOptions) => (framework.redis ? new RedisBus(framework.redis.url) : new LocalBus()),
      },
      {
        provide: JwtService,
        inject: [FRAMEWORK_OPTIONS],
        useFactory: (framework: FrameworkOptions) =>
          new JwtService({
            secret: framework.auth.jwtSecret,
            signOptions: {
              expiresIn: (framework.auth.accessTtl ?? '15m') as never,
              ...(framework.auth.issuer ? { issuer: framework.auth.issuer } : {}),
              ...(framework.auth.audience ? { audience: framework.auth.audience } : {}),
            },
          }),
      },
      ...CORE,
      ...feature(ACL_SOURCE, features.acl, TableAclSource),
      ...(features.acl ? [AclService] : []),
      ...(features.acl === 'tables' ? [PermissionCatalogService] : []),
      ...feature(AUDIT_SINK, features.audit, TableAuditSink),
      ...feature(PLACEMENT_STORE, features.placement, TablePlacementStore),
      ...(features.tokenValidator ? [features.tokenValidator, { provide: TOKEN_VALIDATOR, useExisting: features.tokenValidator }] : []),
      ...(features.admin ? [AdminAclService, AdminPermissionMeta, AdminCatalogService] : []),
      ...(features.services
        ? [
            {
              provide: EventTransport,
              inject: [FRAMEWORK_OPTIONS],
              useFactory: (framework: FrameworkOptions) => (framework.redis ? new RedisStreamTransport(framework.redis.url) : new LocalEventTransport()),
            },
            ServiceDispatcher,
            RemoteCalls,
            ServiceClient,
            EventOutbox,
          ]
        : []),
      ...(managesPlaces
        ? [
            TenantLifecycle,
            CompanyMover,
            {
              provide: MigrationRunner,
              inject: [
                ConnectionRegistry,
                SchemaSync,
                MigrationFiles,
                getModelToken(TenantRouting),
                FRAMEWORK_OPTIONS,
                TenantRunner,
                { token: AdminCatalogService, optional: true },
                { token: PermissionCatalogService, optional: true },
              ],
              useFactory: (
                registry: ConnectionRegistry,
                schemas: SchemaSync,
                files: MigrationFiles,
                routing: typeof TenantRouting,
                framework: FrameworkOptions,
                runner: TenantRunner,
                admin?: AdminCatalogService,
                tenant?: PermissionCatalogService,
              ) => new MigrationRunner(registry, schemas, files, routing, framework, { admin, tenant, runner }),
            },
          ]
        : []),
      { provide: APP_GUARD, useExisting: JwtAuthGuard },
      { provide: APP_GUARD, useExisting: TenantContextGuard },
      { provide: APP_GUARD, useExisting: PermissionGuard },
    ];
    const exported = providers.flatMap((p) => (typeof p === 'function' ? [p] : 'provide' in p && p.provide !== APP_GUARD ? [p.provide] : []));
    return {
      module: FrameworkModule,
      global: true,
      imports: [
        ClsModule.forRoot({ global: true, middleware: { mount: true, generateId: true } }),
        DiscoveryModule,
        SequelizeModule.forFeature(modelsOf(features)),
        ...(options.imports ?? []),
      ],
      controllers: features.services ? [ServicesController] : [],
      providers,
      exports: [...new Set(exported), SequelizeModule],
    };
  }
}
