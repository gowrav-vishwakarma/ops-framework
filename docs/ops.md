# Ops framework (`@ops/framework`)

How a write, a list, or an action runs. The service file only declares the entity, its actions are listed in `<module>.actions.ts`, and the work lives in numbered step files under `src/modules/<entity>/ops/`.

Branch deactivate (TMS) is the example. The map of every entity is generated: `npm run flow` writes the project's `docs/entity-flow.md`. This file is the how-to. When the framework changes, update this file in the same change.

The framework serves several projects (TMS, Ankpal) with different conventions: nothing is hard-coded. Defaults follow the Ankpal style (camelCase columns, a schema another system migrates); a project changes them with `defineNames` and `features` (see *Setting up a project*).

## One request

`POST /api/branches/7/actions/deactivate` opens one transaction and runs:

```
check steps     ops/deactivate/001–399     read, fill state, add issues
                -- blockers stop here (422); warnings ask for confirm (409) --
before steps    ops/deactivate/400–499     last changes before the write
main change     ops/deactivate/500-execute.ts if it exists, else the action's run (status becomes inactive)
after steps     ops/deactivate/501–999     related records, then the audit row
commit
afterCommit     callbacks registered by steps (logs, mail, notifications)
```

Create, update, and delete use the same order. Their main change is built in: `c.row.save()` or `c.row.destroy()`, between the before steps and the after steps, unless the folder has a `500-execute.ts`. A before step can still change fields on `c.row` before that save.

## Folders

| Folder | Runs on | Route |
| --- | --- | --- |
| `save/` | create and update | `POST /`, `PATCH /:id` |
| `create/`, `update/`, `delete/` | that write only | |
| `<action>/` | the action named in the service | see kinds below |
| `list/` | every list | `GET /` |
| `list-<view>/` | one named list, after `list/` | `GET /?view=<view>` |
| `view-<name>/` | a read of one record; steps set `c.result` | `GET /:id/views/<name>` |

An unknown folder, a bad file name, a number in the wrong band, or two files with the same number fails boot. `save` shares its numbers with `create` and `update`. `list` shares its numbers with `list-<view>`.

## Step files

```
ops/deactivate/010-check-assess-open-work.ts
               ^^^ ^^^^^ ^^^^^^^^^^^^^^^^^^^^
               number, phase, name
```

- `NNN-check-name.ts` — 001 to 399. Read only. Fill `state`, add issues. Do not write through `c.t`.
- `NNN-before-name.ts` — 400 to 499. The checks have passed and the user has confirmed.
- `500-execute.ts` (or `500-execute-<name>.ts`) — always number 500, at most one per operation. Replaces the main change. See below.
- `NNN-after-name.ts` — 501 to 999. The main change is done, still inside the transaction.
- The number is the only order. There is no priority field. In the IDE file tree the folder reads top to bottom in run order: checks, befores, `500-execute.ts`, afters.
- A step file may be a flow (data) or code (see *Flows*). `_state.ts` and `_shared/` are helpers. The loader ignores other files that do not start with a number, and folders of `ops/` starting with `_` (`ops/_shared/`, an example kept beside the real operation).

A step is the default export. A plain object needs nothing injected:

```ts
export default step<Branch, DeactivateState>({
  async check({ row, user, count, state }) {
    state.isHeadOffice = row.isHeadOffice;
    state.activeUsers = await count(`users WHERE branch_id = :id AND status = 'active'`, { id: row.id });
  },
});
```

A class step is `@Injectable()` and gets Nest constructor injection. The entity's models must be in that module's `SequelizeModule.forFeature`. Services from `CoreModule` (ACL, document numbers, exceptions, `Notifier`) are global.

`when: (c) => ...` skips the step when it returns false. Add `describe: '...'` so the flow doc shows why.

## Actions file

Each module lists its actions in `<module>.actions.ts` (`branches/branches.actions.ts`, `users/users.actions.ts`, `acl/roles.actions.ts`). The service only points at it: `protected readonly actions = branchActions;`.

```ts
export const branchActions: EntityAction<Branch>[] = [
  ...statusActions<Branch>({ noun: 'branch' }),
  {
    name: 'deactivate-many',
    label: 'Deactivate selected',
    kind: 'bulk',
    permission: 'deactivate',
    from: { status: ['active'] },
    confirm: 'Deactivate the selected branches?',
    danger: true,
    effect: 'status -> inactive',
  },
];
```

- `name` is the route, the `ops/<name>/` folder, and the permission (`branch.deactivate-many`), unless `permission` names another one.
- `from` is the row state it starts from. It also enables the button in the UI.
- `effect` is the one line the flow doc prints for the main change.
- `run` is optional. `statusActions` gives deactivate and activate a `run` that sets `status`.
- `readOnly: true` marks an action that only reads (a report, print or label data): a row action reads its row without
  a lock, and neither kind writes an audit row or runs after-write work. It answers `c.result`.

## Where the save happens: `500-execute.ts`

The check, before, and after files never do the main write. The main write is, in order of precedence:

1. `ops/<operation>/500-execute.ts`, if the folder has one.
2. Otherwise the built-in change: `run` on the action, `c.row.save()` for create and update, `c.row.destroy()` for delete, `runCollection` for a collection action.

The execute file receives `c` and `original`. `original()` runs the built-in change, so the file can replace it, wrap it, or skip it:

```ts
// ops/deactivate-many/500-execute.ts — the action has no run; this is the whole write
export default execute<Branch>({
  describe: 'sets status inactive',
  async run({ row, user, t }) {
    await row.update({ status: 'inactive', updatedById: user.id }, { transaction: t });
  },
});
```

```ts
// wrapping the built-in save of an update
export default execute<Trip>({
  async run(c, original) {
    c.row.set({ closedAt: new Date() });
    await original();
  },
});
```

- `save/500-execute.ts` replaces both create and update. A `create/` or `update/` execute file next to it fails boot.
- On create, leave `c.row` saved. Its id is what gets audited and returned.
- The update audit compares every column with `c.before` after the operation, so an execute file that writes its own way is still audited.
- Lists and views have no execute file. Use before steps to shape the query.
- A collection action uses `collectionExecute({ run(c, original) {...} })`.
- An `@Injectable()` class with a `run(c, original)` method works too, with constructor injection.

`toCreate` and `toUpdate` in the service decide which form fields land on the row before create or update saves. On a `TenantCrudService` the defaults are the DTO without system fields (`withoutSystemFields`: `id`, the partition field and column, `createdById`/`updatedById` in both spellings), so a request can never move a row to another company; an override that maps the DTO itself should start from `withoutSystemFields(dto)` or `super.toUpdate(...)`.

## Issues and state

One `issues` object and one `state` object are created per call and passed to every step. A step does not return them. `issues.block(...)` pushes onto the list; the next step sees the same list.

- `issues.block(code, message)` — hard stop. After the last check step they all come back together as 422 `{ message, errors, blockers }`.
- `issues.field(name, message)` — same 422, placed on a form field (`errors`).
- `issues.warn(code, message)` — 409 `{ needsConfirm, warnings }`. The client resends the same call with `confirm: true` (actions) or `?confirm=true` (create, update, delete).
- `c.unique('code')` — field error when another row in the tenant already has that value.

`state` starts as `{}`. Declare its fields optional in `ops/<operation>/_state.ts`, because earlier steps fill them and later steps read them.

## Passing things to the next step

Every step, the execute file, and the audit share one `c` object. Change it and the steps after see the change:

- **A new value** that is not a column: put it on `c.state` (declare it in `_state.ts`). Example: 010 sets `state.activeUsers`, 020 reads it.
- **A column of the row**: `c.row.set({ ... })` or `c.row.field = value`. In a before step of create or update, that value is saved by the main change.
- **The row after raw SQL or another service changed it**: `await c.reload()` re-reads it inside `c.t` into the same object and returns it. Example: `deactivate/520-after-reload-row.ts`. Before the main change of an update, reload throws away the edits not saved yet; compare with `c.before` there instead.
- **A different row object**: assign `c.row = other`. The framework reads `c.row` for the main change, `c.changed`, `c.unique`, and the audit, so later steps and the save follow it.
- **The response**: set `c.result` and the endpoint returns it instead of the record.

## What a step receives (`c`)

- **Who.** `c.user` (id, companyId, branchId, branchIds, roleId, partyId, name), `c.scope` (the scope id of the permission being run: `all`, `branch`, `own` or one the app registers) and `c.limits` (its authority limits), `c.can('user.view')` for some other permission.
- **The row.** `c.row`, `c.before` (stored values; null on create), `c.dto` (body, or the validated action input), `c.changed('status')`, `c.reload()`. On a bulk action, `c.rows` is the whole selection; the steps still run once per record.
- **Transaction.** Pass `{ transaction: c.t }` on every query. `c.savepoint(work)` rolls back only that work if it throws. `c.separate(work)` commits immediately, even when a later check blocks — do not touch rows this transaction has locked. `c.afterCommit(work)` runs only after a successful commit.
- **Services.** `c.get(UsersService)` resolves any provider without importing its module. Calling `c.get(PartiesService).perform(c.ctx, id, 'settle', input, c.t)` runs that operation's own steps and audit row inside this transaction.
- **Raw SQL.** `c.count('users WHERE branch_id = :id', { id })` and `c.sql(sql, replacements, t?)` (rows as objects; `t` defaults to `c.t`). Both run in the tenant's schema.
- **Other services.** `c.service(Platform).command('inviteMember', input)` / `.query('seats', input)` calls another service's contract (in process or over HTTP, the same either way; see Services). It runs in that service's own transaction, not in `c.t`. `await c.emit(TenantMembers, 'memberConfirmed', payload)` publishes an event durably: written in `c.t`, delivered after commit, never for a rollback. Tenant steps never touch the control plane directly.
- **Other.** `c.result` (return this instead of the saved row).

A query that omits `transaction` sees only committed data, not this operation's own writes.

## Action kinds

Declared in `<module>.actions.ts`. Each action is a permission: `branch.deactivate`.

- **`row`** (default) — `POST /:id/actions/:name`. Steps in `ops/<name>/` around the main change.
- **`bulk`** — `POST /actions/:name` with `{ ids }`. Every record is checked first and blockers come back per record. Then before, the main change, and after run per record, in one transaction.
- **`collection`** — `POST /actions/:name`, no record. Use `collectionStep`, and `runCollection` or `collectionExecute`. Set `c.result` for the response.

`input: SomeDto` validates the body with class-validator before the steps. Field errors go into `issues`. `inputs` is the separate list the UI uses to draw the dialog.

The row menu shows `row` actions only.

### Action metadata and `_actions`

An action also says how the UI shows it. All fields are optional and travel in `GET /<resource>/actions`:

| Field | Meaning |
| --- | --- |
| `icon`, `iconColor`, `tooltip` | looks |
| `shortcut` | a desk key such as `Alt+A`, shown in the label |
| `ui` | `confirm` (yes/no), `form` (the `inputs` dialog), `silent` (runs at once). Defaults from `confirm` and `inputs` |
| `display`, `group` | toolbar or row menu, and the menu section |
| `hideInAcl` | keep the permission out of the role matrix (still enforced) |
| `available(row, ctx)` | a reason the action cannot run on this row now, or `null` |

`GET /<resource>?actions=1` adds `_actions` to every row: `{ <name>: { allowed, reason } }`, one entry per action the caller holds plus `update` and `delete`. `allowed` is false with a reason when the row is in the wrong state (`from`), outside the caller's scope, refused by a row guard (a locked period), over a limit or soft deleted, or when `available` says no. It is a hint for buttons; the steps still decide.

## After every save: `afterSave`

`protected async afterSave(c)` runs after the steps of every create and update, in the write's
transaction, whether or not a column changed (a form's link rows may change alone), before
`afterWrite`. For project-wide save work such as syncing a form's lists (Ankpal `masterResource`
`links` / `children`).

## After every write: `afterWrite`

A service can override `protected afterWrite(c, event)`: called in the write's transaction after the
steps of every create, update (when something changed), delete and row or bulk action, with the
operation context (`c.row`, `c.t`, `c.ctx`, `c.afterCommit`). For a project's cross-cutting write on
every entity (Ankpal's master audit); a rule of one entity stays a step in `ops/`.

## Errors the client sees

A global filter (`ErrorAnswerFilter`, `database-errors.ts`) answers every error:
- an `HttpException` (issues 422/409, `NotFoundException`...) as thrown;
- a database refusal as something the user can act on (`databaseErrorAnswer`): unique → 422
  `<field> already exists`; a link to a missing row → 422 on the field; a row still in use → 409
  `in_use`; required / too long / out of range / badly formed → 422 on the column; a statement
  timeout → 503; a deadlock or serialization conflict → 409 "try again";
- anything else → 500 `{ message, reference }`. The SQL, the stack and the message stay in the log
  under that reference; nothing internal reaches the client.

## Lists and views

A `list/` before step pushes onto `c.where`, `c.include`, or `c.order`. An after step reads `c.rows` and may `row.setDataValue('activeUserCount', n)`.

`list-active/410-before-only-active.ts` adds `where status = active`, so `GET /branches?view=active` runs `list/` and then `list-active/`.

`view-usage/` builds `c.result`. `GET /branches/7/views/usage` returns that object. These steps are read only.

## Setting up a project

The framework is the package `@ops/framework` (`~/Development/ops-framework`). Projects install it as a copy (`.npmrc`: `install-links=true`, dependency `"@ops/framework": "file:../../ops-framework"`); `npm run fw:update` rebuilds and reinstalls it. Nest, sequelize, sequelize-typescript, nestjs-cls, class-validator, pg and ioredis are peer dependencies, so there is one instance of each. App code imports `@ops/framework` (and `@ops/framework/testing` in specs, `@ops/framework/internal` in infrastructure tests). Vitest must inline it (`server.deps.inline: ['@ops/framework']`) so step files loaded with `import()` go through Vite.

**Names, first.** `@ops/framework/names` loads no model. A side-effect module calls `defineNames` and is the first import of `main.ts`, tools and the Vitest `setupFiles`:

```ts
import { defineNames } from '@ops/framework/names';
defineNames({ controlSchema: 'ankpal', userTable: 'Users', partition: { exempt: ['State', 'Currency'] } });   // Ankpal
defineNames({ underscored: true, partition: { column: 'company_id', mirror: 'companies' } });                 // TMS
```

| Name | Default | Meaning |
| --- | --- | --- |
| `controlSchema` | `platform` | schema of control-plane models (a model is a control model when its `schema` equals it) |
| `userTable` | `users` | tenant user table (audit columns, overrides) |
| `underscored` | `false` | `tenantTable()` / `controlTable()` / `referenceTable()` use snake_case columns. The framework's own tables are always snake_case |
| `partition.field` / `column` / `mirror` | `companyId` / `companyId` / `Companies` | tenant attribute, its column, the per-schema mirror table |
| `partition.exempt` | `[]` | models that carry the attribute but are shared (never filled or pinned) |

**Features.** `FrameworkModule.forRootAsync({ useFactory, features })` decides what the framework owns. A feature is off unless set; `'tables'` uses the framework's own tables, a class is the project's implementation of the contract:

| Feature | Contract | `'tables'` | Ankpal |
| --- | --- | --- | --- |
| `acl` | `AclSource.load(user)` -> grants | `roles`, `role_permissions`, `permissions`, `user_permission_overrides` | classic `AclRoles` / `AclRolePermissions` matrix |
| `audit` | `AuditSink.record` / `history` | `entity_events` | classic `tenant_logger` |
| `placement` | `PlacementStore.route` / `activeRoutes` / `shard` | `tenant_routing`, `tenant_shards` | classic `TenantRoutings`, `TenantShards` |
| `tokenValidator` | `TokenValidator.validate(claims, user, req)` | - | stored-token revocation, branch access |
| `services` | contracts, outbox, inbox, `/_ops/calls` | framework tables | off |
| `admin` | admin roles, permissions, audit | framework tables | off |
| `schema` | `owned` (sync, migrations, provisioning, moves) or `external` (default: parity check only) | | `external` (classic's migrations) |

Only enabled features register models and providers, so a project with its own schema meets no framework table. Business rules are not features: period locks, financial years, document numbers and settings are the project's (TMS: `src/modules/period`, `settings`, `sequences`), plugged in as row guards and services.

The options (`FrameworkOptions`) carry the rest:

| Option | What it is |
| --- | --- |
| `catalog`, `scopes` | permissions (resource, action, scopes, limits) and scope providers beyond `all`, `branch`, `own` |
| `acl.actionNames`, `acl.code` | how permission codes are spelled: the framework asks for `list`, `view`, `create`, `update`, `delete`, `restore` and action names (Ankpal: `{ list: 'page', update: 'edit' }`); default code `${resource}.${action}`, `list` defaults to `view` |
| `acl.userStatusColumn` | `features.acl: 'tables'`: a column of `NAMES.userTable` (`'status'`); a user whose value there is not `'active'` is refused (403) when permissions load. Off by default; cached with the permissions, so call `AclService.forgetUser` after changing it (TMS: the users save step) |
| `tenancy.partition`, `resolve`, `placement`, `sharedSchema` | partition, user to tenant (default `{ companyId, tenantKey }`), `single` / `schemaPerTenant` / `routed` |
| `tenancy.headers` | headers checked against the token (default `x-company-id` -> companyId, `x-tenant-id` -> tenantKey or companyId); a mismatch is 403 |
| `auth.userClaims`, `jwtSecret`, `issuer`, `audience`, `tokenKind`, `epoch`, TTLs | claims to `AuthUser`, verification, token kind (default: `typ`, else a company token when it carries the partition field), `epoch: 'required'` to refuse tokens of a moved company (TMS) |
| `secretKey`, `dbSync`, `controlDbUri`, `migrations`, `shardPool`, `shardIdleMs` | owned-schema and pool settings |
| `schemaParity` | `block` (503, default when owned), `warn` (logged once per schema, default when external), `off` |
| `refs.undeclared` | undeclared id columns when building a schema: `error`, `warn` (default), `off` |
| `redis`, `services`, `admin` | as before |
| `logging.http` | `off`, `basic` (default: a `request.start` and a `request.finish` line per request, as JSON under `HTTP`: method, URL, company, tenant, user, status, ms, and `queries`: the SQL statements the request sent on every pool), `verbose` (also the payload and the response body, errors included). Passwords are `[REDACTED]`, tokens cut to their start (`logging.redact` adds keys); bodies cut at `logging.bodyLimit` (4000); `logging.skip` paths are not logged (`/api/health`) |
| `logging.queryHeader` | `true`: every answer carries `x-ops-queries` (statements the request sent) and `x-ops-ms` (time in the server), counted per request by the query guard. For development and test servers (a performance harness reads them); default off |
| `logging.queryCapture` | a folder: every distinct statement (by its shape: literals and placeholders out) is saved once per schema as `<dir>/<schema>/<hash>.json` with the SQL as run and its `bind` / `replacements`, for a script that `EXPLAIN`s them in every schema (missing indexes, slow plans). Never fails a query. Development and test servers only; default off |
| `logging.sql`, `logging.steps` | every SQL statement with its time, on every pool (`SQL:<dbKey>`, debug level; `sqlLogger(options, 'primary')` for the app's own connection), and each step and flow file with its time (debug; `OPS_TRACE=1` too) |

## Tenancy

Every request is bound to one tenant before any query. Models never take a connection: `Model.sequelize` and `Model._schema` are getters that read the request's context (`AsyncLocalStorage`), so `Model.findAll`, `c.t`, and `TenantDb` reach the right database and schema without anything being passed down. The setters throw. Pools start at `search_path=tenant_unset`; a transaction does `SET LOCAL search_path`. Because models bind to one Sequelize per process, each e2e file builds its app once (`beforeAll`).

- **Partition column.** The tenant column is filled on create and pinned on find, count, bulk update and bulk destroy by hooks; a row can never be written for another tenant. `PartitionedModel` types it as `companyId` whatever its configured name.
- **Placement.** `routed` reads `tenant_routing` (status `creating|active|migrating|disabled`, `epoch`, shard, schema) and `tenant_shards` from the control plane, cached. Unknown company: 404. Not `active`: 503. A company being moved gets 503 on every request, not only writes.
- **Topology.** One control database (schema `platform`, or `controlDbUri`) holds the framework's `tenant_routing`, `tenant_shards`, `framework_inbox`, `framework_outbox`, `framework_migrations`, and the project's platform tables (TMS: `users` identities, `companies`, `user_companies`, `refresh_tokens`, `licenses`, `company_licenses`). Tenants live in any database (a `tenant_shards` row) and any schema: shared by many companies (`tenant_shared`) or their own (`tenant_42`). `ControlPlane.tx` is for platform-side code; tenant work uses `TenantDb.tx` / `c.t`.
- **Several pods.** Routes and permission sets are cached per process; a change is broadcast on the cluster bus (Redis pub/sub when `redis` is set) and the TTL is the backstop. A company move waits until no process can still hold the old route before it copies. Shard pools unused for `shardIdleMs` close; `ConnectionRegistry.stats()` shows pool use. Behind RDS Proxy or pgbouncer (`?pooler=true`) no startup option is sent: run `ALTER ROLE <app user> SET search_path = tenant_unset` (boot warns when it is missing).
- **Guards, in order.** `JwtAuthGuard` (signature, issuer, audience, token kind; no database), `TenantContextGuard` (headers from `tenancy.headers` against the token: 403; the route; the epoch when `auth.epoch: 'required'`: 401; schema parity; then the project's `TokenValidator` inside the tenant context), `PermissionGuard`. Headers are checked against the token and never choose the tenant.
- **The company comes from the token only.** In a tenant context every request's body, query and route parameters are searched at any depth (lines, Sequelize-style `where`, `'$assoc.companyId$'` keys, `@Param('companyId')`): a partition value other than the signed-in company is refused with 403 (`code: 'company_input'`); the signed-in company is removed, so no code can come to rely on a request's copy. `TenantContextGuard` checks what the request carries before routing; `CompanyInputPipe`, which the framework adds as the first global pipe (before the app's validation), checks handler arguments built later (multipart bodies). Sign-in, `@LoginToken()` and platform routes have no tenant context and are not touched. Code reads the company from `c.ctx.user` / `requireTenant().ref`, never from a DTO; raw SQL passes it from there.
- **Every query stays in the company.** Model calls: the partition hooks filter find, count, bulk update and bulk destroy, and every joined partitioned model (`include`, any depth; an optional join stays optional); creates and saves get the company, and a row of another company is refused; an upsert by id (`bulkCreate` with `updateOnDuplicate`, `upsert`) is refused when the id is another company's row. The company table itself (`partition.mirror`, which has no partition column: a shared schema keeps every company's row there) is pinned by id: finds, counts, joins, bulk updates and destroys see only the company's own row, and saving or destroying another company's row is refused (creating one is left to provisioning); a CRUD resource on it is scoped to that row (`TenantCrudService.pin`), and the partition is stamped only on models that have it. Raw SQL (`c.sql`, `c.count`, `sequelize.query`) is checked by `tenancy.companySql`: a statement that refers to more partitioned tables than it mentions the partition column is refused (`error`: set it in tests and scenario runs, which run every raw statement) or logged (`warn`); the default `off` costs nothing per query in production. Write raw SQL with `"companyId" = :company` for every partitioned table, joins included (a join on another table's companyId is not enough).
- **Guards on queries.** `installQueryGuards` blocks a query that reaches another database or runs on another tenant's transaction.

### Two-token sign-in

1. `POST /auth/login` (`@Public`) checks email and password against the platform identity and returns a login token (`typ: 'login'`) and the companies to choose from.
2. `POST /auth/switch-company` with `Authorization: Bearer <login token>` opens one company and returns a company access token (`typ: 'access'`, with `cmp`, `ep` epoch, role, branches, `av` ACL version) and a refresh token bound to that platform user and company. The same call, with a company token and the refresh token, switches company.

Routes that take the login token say `@LoginToken()`; every other route needs the company token. `GET /auth/companies` lists the choices again. The web picker preselects the default company, else the last used, and opens it on Enter.

The framework's `SessionTokens` issues the tokens; the project's platform service does the checks (password, membership, license) and keeps refresh tokens through its `RefreshTokenStore`. What the token says about the person inside the company comes from the company's tenant through the `TenantSessions` contract (`profile` for the picker, `open` for the token); `choice` passes what the person picked with the company (a role, a branch) to the tenant. The framework adds `sub`, `uid`, `cmp`, `ep` and `typ` last, so a tenant cannot change them. `GET /auth/me` is served by the tenant service.

A tenant user is a company profile of a platform identity. Creating a user calls `Platform.inviteMember` (identity plus a pending membership), writes the tenant user in `c.t`, and emits `TenantMembers.memberConfirmed`, which activates the membership only once the user committed. Deactivating emits `memberSuspended` (sessions end), deleting `memberRemoved`. Company admins cannot change a platform user's email or password through the tenant user form.

### Portals and API keys (audiences)

Besides the company's own users, an app can serve other signed-in callers: a customer's or vendor's portal, a
salesman's or driver's app, an integration calling the API.
- **Portals:** declare each in `auth.audiences` as `{ matches(claims), userClaims(claims) }`. `matches` runs before
  the company kind, and `userClaims` maps the token to a user of its company, with `partyId` for a party's portal (the
  `own` scope and `partyFields` then keep it to that party's rows).
- **API keys:** an integration's key is a `features.apiKeys` class, `validate(key, request)`, returning the user the key
  acts as (whose permissions apply). It runs before the tenant context, so it reads control-plane tables only.

A route serves them only when it says so: `@Audience('customerPortal')`, `@Audience('apiKey')`, or
`@Audience('customerPortal', 'company')` to share a route with the company's users. A route without `@Audience`
refuses every portal token and key; a route with it refuses company tokens unless it names `'company'`. The request
carries `audience` (absent for company users), so the project's `TokenValidator` checks each kind its own way.
Operations do not change: a portal endpoint calls the same service with the portal user's context and scope.

### Moving a company

`npm run company:move -- --company 2 --to-schema tenant_shared [--to-db primary] [--keep-source]` runs `CompanyMover`: it copies the company's rows into the target (auto-increment ids are given anew; ids that are not generated by a sequence, such as UUIDs, are kept, and references to them are left as they are) (a schema that may already hold other companies), in one target transaction, remaps real foreign keys while inserting and soft or polymorphic references afterwards, matches reference tables (`permissions`) by natural key, then switches the route (`migrating`, epoch + 1) and removes the source. The CLI then revokes the company's refresh tokens; the epoch bump already invalidates its access tokens.

Before copying, the move checks that source and target are at the same migrations (a new target is built from the models and recorded at the app's migrations) and refuses otherwise; it copies exactly the columns the models declare.

### Declaring references

The mover and the boot check read the model declarations. A column ending in `Id` must be a real foreign key (`@ForeignKey`) or be declared:

- `@SoftRef('table', { zeroIsSystem })` a reference without a database constraint (audit columns, `branchId` where 0 means all)
- `@NotARef()` a number that merely looks like an id
- `@Polymorphic({...})` on the class for `entityType` + `entityId` style pairs
- `referenceTable(name, naturalKey)` for shared lookup tables copied by key, not by id

An undeclared id column fails boot (`undeclaredIdColumns`). Table order for the mover comes from hard foreign keys only.

## Services: platform and tenant

A project has two services: the **platform** (control plane: identities, companies, licenses, partners, sign-in) and the **tenant** service (everything a company works with, in its own database and schema). They never touch each other's data; they talk through **contracts**:

```ts
export const Platform = defineContract({
  name: 'platform',
  plane: 'control',                        // where the handler's data lives: 'control' | 'tenant'
  calls: {
    inviteMember: command<InviteMemberDto, { platformUserId: number }>(InviteMemberDto),
    seats: query<CompanyRefDto, Seats>(CompanyRefDto),
  },
  events: { /* ... */ },
});

@Implements(Platform) @Injectable()
export class PlatformApi implements Handlers<typeof Platform> {   // the compiler checks every method
  async inviteMember(input: InviteMemberDto, { t }: CallCtx) { /* writes with { transaction: t } */ }
  async seats(input: CompanyRefDto, { t }: CallCtx) { /* ... */ }
}

@Injectable()
export class MemberEvents {
  @Subscribe(TenantMembers, 'memberConfirmed', { plane: 'control' })
  async confirmed(payload: MemberEventDto, { t }: EventCtx) { /* ... */ }
}
```

Callers use `ServiceClient.for(Contract)` (in steps: `c.service(Contract)`); events go out with `EventOutbox.emit(t, Contract, 'event', payload)` (in steps: `c.emit`). The same rules hold in every deployment:

- the input is validated on the receiving side (field errors come back as 422); results are plain JSON;
- a handler runs in its own transaction on its plane; a tenant handler also runs in the call's company (the caller's company by default, `{ companyId }` to choose);
- a command called with `{ key }` runs once per key: a retry gets the stored result (the record commits with the handler's work);
- HTTP errors pass through as they are; any other error becomes a plain 500;
- an event is written in the emitter's transaction (`framework_outbox` of that database), published after commit, re-published by the sweeper if a process died in between, and delivered at least once to each subscriber method, which skips repeats (`framework_inbox`).

The framework relies on two contracts the project implements on its tenant side: `TenantSessions` (sign-in) and `TenantProvisioning` (build and seed a company's place). Everything else (TMS: `Platform`, `TenantMembers` in `src/platform/contracts.ts`) is the project's. Tenant modules import only that contracts file from `src/platform` (boundary spec).

### Deployments

One image, `SERVICES=platform,tenant` (default: both, in one process; dev and on-prem). In the cloud, run it twice:

| | platform | tenant |
| --- | --- | --- |
| `SERVICES` | `platform` | `tenant` |
| `SERVICE_ENDPOINTS` | `tenant-sessions,tenant-provisioning=http://tenant:3000/api` | `platform=http://platform:3000/api` |
| both | `SERVICE_SECRET`, `REDIS_URL`, `JWT_SECRET`, `DATABASE_URI` | |

A contract answered in the process is called in process; otherwise over internal HTTP at `POST <endpoint>/_ops/calls`, signed with HMAC (timestamp plus body, 60 s window) and load-balanced by the platform (Kubernetes Service, ECS Service Connect). Queries and keyed commands are retried on network errors and 502-504. Keep `/_ops` on the internal network. Events travel on Redis Streams (`ops:events:<contract>`): each subscriber method is a consumer group, so it gets every event once however many replicas run; a message unacknowledged for 60 s is claimed by another replica, and after 10 deliveries it is parked on `ops:events:dead`. Route the public `/api/auth/me` and tenant paths to the tenant service, `/api/auth/*` and `/api/admin/*` to the platform. Every replica is stateless; scale each service on its own.

## Migrations

`sync` (`DB_SYNC=alter`) is for local development only and is refused when `NODE_ENV=production`. Each model syncs in a savepoint: when `alter` tries to add a column or index Postgres already has (`42701`, `42P07`, such as an index name truncated at 63 characters), that model is logged and left as it is instead of failing the schema. Schemas change through migrations:

- `src/migrations/control/` runs once on the control plane; `src/migrations/tenant/` in every tenant place (every distinct database and schema in `tenant_routing`). Files are `YYYYMMDDHHMMSS-name.ts`, default-exporting `migration({ up({ qi, t, schema }), down? })`. `qi` is pinned to the schema; pass `{ transaction: t }`. Write migrations against the database, never through models.
- `npm run migrate:new -- tenant add-vehicle-color` creates a file; `npm run migrate` applies everything (control first; a failing tenant place is reported, the others continue; the job exits non-zero); `npm run migrate:status` lists what is pending; `--only`, `--db`, `--schema` narrow a run; `migrate undo` reverts one schema's last migration locally.
- Each migration runs in its own transaction with the schema's `search_path`, is recorded in `framework_migrations` in that transaction, and holds an advisory lock per schema, so two runners never apply it twice. Dev `alter` syncs take the same lock.
- A new place (a new company in its own schema, a new shard) is built from the models and records every existing migration as applied. A request to a schema whose tables lag the models gets 503.
- Run the migration job before rolling out new code, as a one-off task (Kubernetes Job, ECS task) with `SERVICES` unset, so every model is known.

## Admin side (control plane)

The same operations framework runs the platform's admin panel: `ControlCrudService` is to control-plane tables what `TenantCrudService` is to a company's. Steps, `500-execute.ts`, actions (`row`, `bulk`, `collection`), list views, limits, `_actions`, `editLocks`, dependents and history all work the same; what differs is the plane:

| | `TenantCrudService` | `ControlCrudService` |
| --- | --- | --- |
| who | `AuthUser` (company token) | `AdminUser` (admin token, `typ: 'admin'`) |
| pin | the caller's company | none |
| transaction | the tenant's schema | the control plane (`ControlPlane.tx`) |
| permissions | `roles` / `role_permissions` in the tenant schema (`AclService`) | `admin_roles` / `admin_role_permissions` (`AdminAclService`) |
| scopes | `all`, `branch`, `own`, `options.scopes` | `all`, `own` (created by the admin), `options.admin.scopes` |
| audit | tenant `entity_events` | control `entity_events` (`ControlEvent`, with the admin's name) |

- `crudController({ ..., plane: 'control' })` marks the controller `@AdminRoutes()`: only admin tokens are accepted, a company token is refused (and an admin token is refused on company routes), no tenant context is set, `@RequirePermission` checks the admin's grants.
- Steps of a control entity type the admin: `step<PlatformCompany, object, Dto, AdminUser>({...})`. `CrudService`, the contexts, `EntityAction` and `ScopeDef` take the user type as their last parameter, defaulting to `AuthUser`.
- `ControlModel` adds `createdById` / `updatedById` (admin ids) to a control table; `ControlCrudService` stamps them.
- `FrameworkOptions.admin`: `catalog` (admin permissions, built with `buildCatalog`), `scopes`, `userClaims` (token claims to `AdminUser`), `tokenTtl`. `SessionTokens.adminToken(id, claims)` signs the token after the project's own sign-in.
- `AdminAclModule` (framework) serves admin roles and their permission matrix at `/admin/roles` and `/admin/permissions`; `AdminCatalogService` keeps `admin_permissions` equal to the catalog, creates a `SUPER_ADMIN` system role when none exists, and gives system roles everything.
- Who the admins are, their sign-in and every admin screen are the project's. TMS: `src/platform/admin/` (admin users, companies with registration as `create`'s `500-execute.ts`, plans, company licenses, sign-ins, memberships, databases with encrypted connection strings, placements with a `move` collection action). Route `/api/admin/*` to the platform service.
- The migration job syncs both catalogs: the admin catalog after the control plane, each tenant schema's catalog after that schema, so a new permission reaches every schema with the deploy.

## Permissions: scopes and limits

A grant is `{ scope, limits }`. The catalog lists the scope ids each permission accepts; roles and per-user overrides store the id and the limits (JSONB). Both are validated on save: unknown code, scope the entry does not offer, unknown limit key, or a negative number is a field error on `permissions`.

**Scopes** are strings resolved through a registry. `all`, `branch` and `own` are built in; the app adds more through `options.scopes`, and a service lists the ones it supports in `protected readonly scopes`:

```ts
export const activeOnlyScope: ScopeDef = {
  id: 'active-only',
  label: 'Active records',
  where: () => ({ status: 'active' }),     // for lists, get and writes
  allows: (_ctx, row) => row.get('status') === 'active',  // one loaded row, no query
};
```

A scope id nobody provides denies. The effective permission set is cached per `company:user:role:av`; changing a role or override bumps the version. `AclService.forgetUser(companyId, userId)`, `forgetRole(companyId, roleId)` (every user holding the role, after its permissions are edited) and `forgetCompany(companyId)` drop cached sets in every process, through the cluster bus.

**Limits** cap what a grant allows (approve up to an amount). A service declares them on `create`, `update`, `delete` (`protected readonly limits = { update: [AMOUNT] }`), and an action declares `limits: [...]`:

```ts
const AMOUNT: LimitDef<Invoice> = { key: 'amount', label: 'Up to amount', type: 'money', value: (row) => Number(row.total) };
```

Over the limit blocks with `limit_exceeded` before the steps; in a bulk action it is reported per record. Unset means unlimited. `c.limits` holds the caller's limits for custom rules. The matrix shows a Limit column built from the catalog's `limits`.

## References stay in the company

Before a create's or update's check steps, the framework checks every foreign key the write sets
(create) or changes (update) whose target model carries the partition field and is not `exempt`:
the target row must belong to the record's company. In a shared schema the database's foreign key
only proves the row exists, maybe in another company. All of a write's keys are one statement
(`SELECT i WHERE EXISTS (...) UNION ALL ...`); a miss is a 422 field error on the key
("The selected main category was not found."). Empty keys (`null`, `0`, `''`) and shared tables are
left to the database. Values steps set later are the server's own and are not checked
(`src/crud/ref-checks.ts`).

## JSON columns: typed shapes

A JSON column gets a shape class whose fields carry `JsonField.*` decorators (`src/crud/json-columns.ts`):
`bool()`, `text()`, `number({ numeric? })` (`numeric`: a string holding a number too), `oneOf([...])`,
`any()` (deliberately open), `object(() => Shape, { or?: ['number'] })` (a record, or e.g. its id),
`list(() => Shape | 'text' | 'number')`, `map(() => Shape)` (free keys such as series types or user ids,
each entry an object or null). Every field may be left out or null. A column that is itself a map
(default series by voucher type) uses `jsonMapShape(() => Entry)` as its shape, a column that is a
list `jsonListShape(() => Entry)`.

A CRUD service declares `jsonColumns = { itemSettings: ItemSettings }`. A create or update that sends
one of them checks it before guards, limits and check steps:

- a wrong type is a 422 field error on its path (`itemSettings.qtyDecimal`), every problem at once;
- a key the shape does not declare is dropped and logged once (`JsonColumns` logger), unless the client
  sent it back unchanged from the stored value (forms load a column and post it whole): then it stays,
  so an incomplete shape never erases stored data;
- the row takes the checked value: the column is replaced (a plain JSON update), keys the client left
  out are not merged back.

Columns a write does not send are left alone. A save that does not go through the CRUD service (a
`500-execute.ts`, a service writing the column) calls `applyJsonColumns(c, { column: Shape })` from a
step, or `checkJson(Shape, value, { path, stored })` for the result (`value`, `problems`, `dropped`, `kept`).

## Bulk inserts run in batches

`Model.bulkCreate` is batched for every model (`installBulkCreateChunking`, installed when the framework
binds the tenant models): more than `BULK_CHUNK` (1,000) rows run as several statements of at most that
many, in order, with the same options, and the answer is every row in the order given. One statement per
call grows without bound (a voucher of thousands of lines, thousands of generated labels): slow, heavy on
memory, and Postgres refuses more than 65,535 bind parameters in a statement. Pass the write's
transaction (every ops write does) so the batches commit or roll back together. Raw SQL with a long id
list passes the ids as one array parameter (`= ANY($1::int[])`, `UNNEST`) or as one JSON parameter
(`jsonb_to_recordset`), never one parameter per id.

## Row guards (project rules on every write)

A period lock, a closed financial year or a frozen document is a project rule; the framework runs it. A service lists them, the framework runs them before the check steps of every create, update, delete and action, in `_actions` hints, and on writes to that model from flow steps:

```ts
protected readonly guards = [periodLock<Invoice>('invoiceDate')];   // TMS: src/modules/period/period-lock.guard.ts
```

```ts
export interface RowGuard<M, U> {
  id: string;                     // 'period-lock'; actions skip it with skipGuards: ['period-lock']
  code?: string;                  // issue code, default the id
  describe?: string;              // flow document
  prepare?(ctx, get, t?): Promise<unknown>;   // loaded once per transaction (a bulk action asks once) or per list
  reason({ op, row, before, ctx, prepared, can }): string | null | Promise<string | null>;
}
```

A refusal is a blocker (422). `can('period.unlock')` lets a guard give way to a permission.

### Every write of an operation is guarded (the write guard)

While an operation's steps run (`create`, `update`, `delete`, actions), the framework knows who the operation writes for, and model hooks check **every** create, update and delete on a tenant model, whether a flow step, a code step or a service it calls makes it (`src/crud/write-guard.ts`):

- the **row guards** of the model written (a closed year refuses a ledger row as it refuses the invoice);
- the caller's **scope**: the operation's own records against the whole scope (`branch`, `own`, the branches a grant names); rows of other models against the scopes marked `related: true` (data split along a dimension those rows carry, such as a branch: a branch-limited user cannot take stock or post a ledger row in another branch). Ownership (`own`) is not related: a salesman limited to his own invoices still takes stock from lots others created. A bulk update or delete loads the rows it touches when a check applies, so the per-row check runs.

`asSystem(() => work)` lifts the scope (never the guards) for integrity writes the system makes whatever the caller's reach; say why where you use it. Writes outside operations (sign-in, jobs, migrations) are not checked. A refusal is a 422 blocker (`out_of_scope` or the guard's code).

## Caches cleared after writes (`cacheRules`)

A cache of database rows (a company's context in Redis, permissions held in memory) goes stale when those rows change.
Instead of clearing it by hand in every step that writes them, the project lists its caches once, with the models whose
writes make them stale:

```ts
cacheRules: [
  { id: 'company-context', models: ['CompanySettings', 'Series', 'Branch'], clear: (companyIds, get) => get(AuthCache).invalidateCompanies(companyIds) },
  { id: 'company-row', models: ['AnkpalCompany'], companyOf: (row) => row.id as number, clear: ... },
]
```

The framework hooks those models when it binds them (tenant and control models; never in the model files, so copied
models stay as they are): every create, update, upsert, bulk write and delete, from any step, service or flow, records
the companies it touched (the row's partition field, a rule's `companyOf`, a bulk statement's condition, else the
request's company). After the outermost transaction commits, each rule's `clear` runs once with those companies (a
write without a transaction: on the next tick). A rolled-back write clears nothing; a failing `clear` is logged.

Only caches the reader rebuilds from the database on a miss belong here. A signed-in session is not one: dropping it
signs the user out, so revoking it stays an explicit step of the action that means it (block, remove, role change).
Raw SQL writes are not seen; name the cache in that step. In-process caches of other processes need `redis` set (the
cluster bus carries `AclService.forgetCompany` and the like).

## Soft delete and restore

`tenantTable('invoices', indexes, { softDelete: true })` makes the model paranoid, and the service sets `protected readonly softDelete = true`. Delete then sets `deleted_at`, normal reads skip the row, and the framework adds a `restore` action (permission `<resource>.restore`, which must be in the catalog). `GET /<resource>?deleted=1` lists deleted records and needs that permission. A dependent that is also soft deleted sets `paranoid: true` in `dependents` so its deleted rows do not block.

## Testing a step without the database

`fakeOpContext` and `runSteps` (from `@ops/framework/testing`) build the same `c` and run the phase methods in order. Give answers for `c.service()` calls with `calls: { 'platform.seats': { used: 1, max: 5 } }`; `c.emitted` and `c.calls` record what the steps sent. See `branches/ops/deactivate/deactivate.spec.ts`. Test an execute file by calling its `run(c, original)` directly with a fake `original`.

## Flows: step files written as data

A flow is a step file written as data. It is numbered like every step file (`ops/<op>/NNN-<phase>-<name>.ts`), so flows and code steps interleave in any order; the number band keeps checks before writes. `checkFlow` / `beforeFlow` / `afterFlow` type the steps for their phase (a write in a `checkFlow` does not compile) and the loader checks that the helper matches the file name; plain `flow({ steps })` takes any steps. Every flow is checked when the app boots (kinds, phases, expressions, fields, methods); a mistake fails boot with the file and step position. An unnumbered `flow.ts` fails boot.

Steps are written with **builders**: every kind is a function (`Flow.lookup(...)` for the built-ins, the project's own imported from where they are defined), so the editor checks the arguments and Ctrl+click opens the kind's code. The object form `{ kind: 'lookup', ... }` is the same step.

```ts
// ops/save/010-check-unique-name.ts
export default checkFlow<Charge>({ steps: [Flow.unique({ fields: ['name'], message: 'The name must be unique.' })] });

// ops/save/410-before-normalize-decimals.ts  (normalizeDecimals: an Ankpal kind, imported from src/flow-kinds)
export default beforeFlow<Charge>({ steps: [normalizeDecimals({ rate: ['defaultValue'] })] });
```

A larger one, Ankpal's sales invoice (`tenant/SalesInvoice/ops/create/610-after-take-stock-out.ts`), reads as the business rule:

```ts
Flow.match({ model: 'SerialNumber', field: 'serialNumber', values: 'sold.serialNumbers', where: { productId: 'sold.productId', status: "'in'" }, as: 'inStock', missing: 'notInStock' }),
Flow.match({ model: 'SerialNumber', field: 'serialNumber', values: 'notInStock', where: { productId: 'sold.productId' }, as: 'knownElsewhere', missing: 'neverSeen' }),
Flow.forEach({ items: 'union(inStock, knownElsewhere)', as: 'serial', steps: [
  Flow.call({ method: 'soldValues', args: { sold: 'sold', serial: 'serial' }, as: 'soldValues' }),
  Flow.update({ model: 'SerialNumber', where: { id: 'serial.id' }, values: 'soldValues' }),
] }),
Flow.createMany({ model: 'SerialNumber', rows: 'newSerials', into: 'createdSerials', when: 'count(newSerials) > 0' }),
```

Two languages, kept apart:

- **Expressions** (`'data.qty * data.rate'`, `"row.status = 'active' and data.amount > 1000"`) compute values and conditions, nothing else: no data access, no control flow, never `eval`. Names: `data` (body or action input), `row`, `before`, `user`, `state`, `op`, `failed` (a check already failed), and every name a step gives a value (`as`, `missing`, `into`, `let` keys; null until it does). Any other name fails boot. SQL null rules; decimals that arrive as text compare as numbers. Functions from a fixed list plus `defineExpressionFunction`: `coalesce`, `either` (JavaScript's `a || b`: the first that is set and not empty, zero or false), `if`, `round`, `lower`, `concat`, `number`, `date`, `fy`, `fystart`, `adddays`, `daysbetween`, `today`, `now`...; lists: `count`, `sum`, `pluck`, `distinct`, `union`, `except`, `first`, `any`, `every`, `filter`, `flatten` (a field of each item named as text: `sum(data.items, 'netTotal')`); what a value is: `istext`, `isnumber`, `islist`, `isobject`, `idof` (the id of a reference sent as an id or a record). A string argument of a step is an expression (text literals are quoted: `"'IGST'"`); numbers, booleans and null are values. Expressions read only a value's own fields (never `constructor` or `__proto__`); numbers are JavaScript numbers (`0.1 + 0.2` is not exactly `0.3`), so money is compared after `round(x, 2)`, which rounds halves away from zero like Postgres. A `lookup`, `find`, `match`, `update` or `destroy` whose condition expression gives no value does nothing (it never matches `IS NULL` rows); a literal `null` is a condition on null.
- **Steps** do the work: `block`, `warn`, `require`, `unique`, `notReferenced`, `lookup`, `find`, `match` (the rows a model has for a list of values, and the values it has not), `let`, `state`, `assign` (values into `data.x` / `state.x`: for requests that are their own working document), `set` (before; `from: 'data'` copies every field of the model an object has), `create`, `createMany` (one insert, one row per item or from ready rows), `update`, `destroy`, `syncChildren` (before/after), `if`, `forEach`, `try` (optional work in a savepoint: a failure that is not a refusal undoes only those steps and is logged), `stop`, `call`, and for lists `where` (before) and `decorate` (after). Every step takes `when` (runs when true), `unless` (skipped when true, runs when the value is missing) and `describe`. `block` in a check step joins the other issues (`Flow.stop({ when: 'failed' })` stops at the first, as classic code did); later it stops at once with the same 422. A `lookup` or `find` whose condition names a missing value finds nothing.
- **Code in the same file.** `methods: { split(run, args) {...} }` and `Flow.call({ method: 'split', args: {...}, as: 'parts' })` hold what is not repetitive (a column map, a calculation): a flow is the paragraph, a method a footnote.
- **Project kinds** name the project's repeated rules so the files read as business: `export const financialYearOpen = defineStepKind({ name, phases, target, fields, names, validate, run, describe })` returns the builder; typed by declaration merging:

  ```ts
  declare module '@ops/framework' {
    interface FlowStepKinds<M> { normalizeDecimals: { rate?: Field<M>[]; qty?: Field<M>[] } }
    interface FlowKindPhases { normalizeDecimals: 'before' }
  }
  ```

**Mistakes are caught early.** Write `checkFlow<Charge>({...})` (or `beforeFlow` / `afterFlow`):

- the compiler: builders type their arguments, and in the object form `kind` is a union of the registered kinds (autocomplete, typos do not compile); `checkFlow` / `beforeFlow` / `afterFlow` accept only the kinds allowed in that phase (`FlowKindPhases`: `set` or `normalizeDecimals` in a `checkFlow` do not compile); field arguments typed `Field<M>` (`unique.fields`, `set` keys, `normalizeDecimals.rate`) accept only the model's attributes (`'defaultValu'`: "did you mean 'defaultValue'?");
- the boot: the same rules again, plus `row.x` / `before.x` inside expressions and every kind's `fields` against the real model's attributes, and expressions parsed. Expressions stay text (names under `data` come from the body and are not checked).

**Data access in flows is never wider than the operation.** Data steps go through `FlowDb` (no raw SQL): the tenant is always pinned by the models; the caller's data scope (branch, own, the branches a grant names) limits every `lookup`, `find`, `match`, `create`, `createMany`, `update`, `destroy` and `syncChildren` the way the write guard does (the operation's own model by the whole scope, other models by `related` scopes; creating or moving a row outside it is refused) unless the step says `asSystem: true`, which the flow document shows; the row guards of the model written always run. `unique` and `notReferenced` count across the whole tenant (an integrity rule must see every row) and return no data. A write touching more than 5,000 rows is refused, never truncated.

Test a flow without a database: `runFlow(file, 'check', fakeOpContext({ dto, row, services: [[FlowDb, fakeDb]] }))` .

## Seeing it

`npm run flow` rewrites `docs/entity-flow.md` from the running modules: every operation, its route, its step files, and `=> effect` where the main change sits (or `=> <op>/500-execute.ts (replaces: ...)`). `OPS_TRACE=1` logs each step and its time. An unexpected error from a step is rethrown with the file name prefixed, `[ops] branches/ops/deactivate/020-check-enforce-rules.ts: ...`.

History of one row is `GET /<resource>/:id/history`.

## Tests

Unit specs (`npm test`) need no database: steps and flows with `fakeOpContext` / `runFlow`, and pure rules such as scopes, limits, row guards, `_actions` and the partition hooks. End-to-end specs live in the projects (TMS below; Ankpal: `ankpal-ops-backend/test`, on a clone of the auto-tester template). TMS: end-to-end specs (`npm run test:e2e`, `*.e2e-spec.ts`) use one app per file because models bind once per process; `test/support/e2e-invoice.ts` is a small entity that exercises scopes, limits, period lock, `_actions` and soft delete. E2E files run one after another (`fileParallelism: false`): each boots against the one dev database with `DB_SYNC=alter`, and an alter must not meet another file's queries. Beyond those: `admin-panel.e2e-spec.ts` (admin tokens, registration from the panel, suspend, license cancel, membership block, password reset, admin roles, audit, masked database secrets, a move), `services.e2e-spec.ts` (contract rules in one process), `migrations.e2e-spec.ts`, `topology.e2e-spec.ts` (one control database, tenants in shared and dedicated schemas on two databases: sign-in, isolation, migrations, a move across databases), `redis.e2e-spec.ts` and `split-deployment.e2e-spec.ts` (platform and tenant in separate processes over HTTP and Redis Streams; both need Redis at `E2E_REDIS_URL`, default `redis://127.0.0.1:6379`, and skip without it). `npm run db:reset` rebuilds the platform and two demo companies.
