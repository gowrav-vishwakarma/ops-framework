/**
 * The public API of the ops framework. App code imports from here (and tests from `testing.js`),
 * never from a file inside `src/framework`: `boundary.spec.ts` enforces it. Anything not exported
 * here is internal and may change without notice.
 */

// Module and options
export * from './framework.module.js';
export * from './options.js';
export * from './naming.js';
export * from './errors.js';
export * from './dto.js';
export * from './money.js';

// Migrations
export * from './migrations/migration.js';
export { MigrationFiles } from './migrations/migration-files.js';
export * from './migrations/migration-runner.js';

// Cluster
export * from './cluster/cluster-bus.js';
export { RedisBus } from './cluster/redis-bus.js';

// Services: contracts between deployments
export * from './services/contract.js';
export * from './services/decorators.js';
export { ServiceClient, type CallOptions, type ContractClient } from './services/service-client.js';
export { EventOutbox } from './services/event-outbox.js';
export { EventTransport, LocalEventTransport } from './services/event-transport.js';
export { RedisStreamTransport, DEAD_STREAM } from './services/redis-stream-transport.js';
export { ServiceDispatcher, validated } from './services/dispatcher.js';

// Platform ↔ tenant: the contracts the framework relies on and the sign-in token machinery
export * from './platform/index.js';

// Auth
export * from './auth/auth-user.js';
export * from './auth/decorators.js';
export * from './auth/password.js';
export * from './auth/system-ctx.js';

// ACL
export * from './acl/acl.service.js';
export * from './acl/catalog.js';
export * from './acl/catalog-types.js';
export * from './acl/limits.js';
export * from './acl/permission-catalog.service.js';
export * from './acl/permission.model.js';
export * from './acl/role.model.js';
export * from './acl/role-permission.model.js';
export * from './acl/scopes.js';
export * from './acl/user-permission-override.model.js';

// Admin side (control plane): roles, permissions, audit
export * from './admin/admin-acl.service.js';
export * from './admin/admin-catalog.service.js';
export * from './admin/admin-permission.model.js';
export * from './admin/admin-role.model.js';
export * from './admin/admin-role-permission.model.js';
export * from './admin/admin-role.dto.js';
export * from './admin/admin-grants.service.js';
export * from './admin/admin-roles.service.js';
export * from './admin/admin-acl.module.js';
export * from './admin/control-event.model.js';

// Audit
export * from './audit/entity-event.model.js';
export * from './audit/table-audit.sink.js';
export * from './acl/table-acl.source.js';
export * from './features.js';

// Database: models, columns, references
export * from './db/columns.js';
export * from './db/refs.js';
export * from './db/rel.js';
export * from './db/tenant.model.js';

// Operations (CRUD, steps, actions, lists)
export * from './crud/crud-controller.js';
export * from './crud/entity-action.js';
export * from './crud/flow.js';
export * from './crud/issues.js';
export * from './crud/json-columns.js';
export * from './crud/list-query.dto.js';
export * from './crud/op-context.js';
export { opsFolder } from './crud/ops-loader.js';
export * from './crud/status-actions.js';
export { CrudService } from './crud/crud.service.js';
export * from './crud/tenant-crud.service.js';
export * from './crud/control-crud.service.js';

// Company features
export * from './notify/notifier.service.js';

// Tenancy
export { PRIMARY, CONTROL, connectionOptions, isPooler, ConnectionRegistry, type PoolStats } from './tenancy/connection-registry.js';
export { currentTenant, requireTenant, runWithTenant, quoteIdent, tbl, TenantContextError, type TenantRef, type Placement, type TenantContext } from './tenancy/context.js';
export { CompanyInputPipe, CompanyInputRefused, checkCompanyInput } from './tenancy/company-input.js';
export { installCompanySqlCheck, missingCompany, CompanySqlRefused, type CompanySqlCheck } from './tenancy/company-sql.js';
export * from './tenancy/control/tenant-routing.model.js';
export * from './tenancy/control/tenant-shard.model.js';
export { encryptSecret } from './tenancy/control/shard-crypto.js';
export * from './tenancy/lifecycle.js';
export * from './tenancy/move/move-company.js';
export { PARTITION, partitionValue, type PartitionConfig } from './tenancy/partition.js';
export * from './tenancy/placement.js';
export * from './tenancy/schema-sync.js';
export * from './tenancy/tenant-db.js';
export * from './tenancy/tenant-runner.js';
export * from './crud/row-guard.js';
export { asSystem, operationAccess, runAsOperation, WriteGuard, outOfScope, type OperationAccess } from './crud/write-guard.js';
export { sequelizeOf } from './tenancy/guards.js';

// Flows: step files written as data, and the expression language they use
export * from './flow/index.js';
export * from './expr/index.js';
export * from './acl/scope-registry.js';
export * from './logging/request-log.js';
export { databaseErrorAnswer, ErrorAnswerFilter } from './database-errors.js';
export { installQueryCapture, queryShape } from './logging/query-capture.js';
