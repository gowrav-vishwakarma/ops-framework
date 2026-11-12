# @ops/framework

[![tests](https://github.com/gowrav-vishwakarma/ops-framework/actions/workflows/test.yml/badge.svg)](https://github.com/gowrav-vishwakarma/ops-framework/actions/workflows/test.yml)

The operations engine behind TMS and the Ankpal ERP rebuild. It is a NestJS and
sequelize-typescript library: every create, update, delete, list and action of an
entity runs as numbered step files, inside one transaction, with tenancy, permissions,
row guards and audit already in place.

The how-to is [`docs/ops.md`](docs/ops.md). This page is why the framework is shaped
this way, and what a project gets from it.

## Why

An ERP write is rarely one `save()`. Raising a sales invoice has to know the year is
open, the stock and serials are there, the totals add up, and then write the invoice,
its lines, the stock movement and the audit row. If any check fails, none of that
should remain. Deactivating a branch, posting a trip, editing a role: the same shape,
different rules.

Left in a service method, that shape drifts. A check runs after the row is already
saved. One blocker hides the rest, so the user fixes them one at a time. A query in
the middle of the method forgets the transaction and opens a second connection, which
cannot see the rows this request just wrote. Audit is a line someone copies, or
forgets. A bulk action checks the first id and then writes the rest. The button in
the UI and the permission on the server are two lists that drift apart.

The framework makes the shape the only way a write runs. A module declares the entity
and its actions. The rules live in a folder of numbered files. The framework opens
the transaction, runs the files in order, returns every blocker together, writes the
audit row, and commits. Mail and notifications run only after that commit succeeds.

## What one request does

`POST /api/branches/7/actions/deactivate` is one transaction:

```
check    ops/deactivate/001–399     read, fill state, collect issues
         blockers stop here (422, all of them); warnings ask for confirm (409)
before   ops/deactivate/400–499     last changes before the write
write    500-execute.ts if present, otherwise the action's own run
after    ops/deactivate/501–999     related records, then the audit row
commit
after    callbacks registered by steps (mail, notifications, logs)
```

Create, update and delete use the same order. Their write is `c.row.save()` or
`c.row.destroy()` unless the folder has a `500-execute.ts`. A before step can still
set fields on `c.row`; the save that follows persists them.

The file tree is the run order. There is no priority field. A bad file name, a number
in the wrong band, two files with the same number, or an unknown folder fails boot,
so a mis-ordered rule never reaches a request. An unexpected error is rethrown with
the file name in front of it. `npm run flow` in a project rewrites `docs/entity-flow.md`
from the modules that are actually loaded: every operation, its route, its step files,
and where the write sits.

## What this improves

**Every blocker comes back together.** Check steps (001–399) only read. `issues.block`
and `issues.field` accumulate; after the last check they return as one 422, so a form
can mark every wrong field at once. `issues.warn` is a 409 `needsConfirm`: the client
resends the same call with `confirm: true`. The user sees the warning, agrees, and
the write proceeds. Nothing is written while a check can still refuse.

**The write has one place.** Check, before and after files never perform the main
change. That change is `500-execute.ts` when the folder has one, and otherwise the
built-in save, destroy, or the action's `run`. An execute file receives `original()`,
so it can replace the built-in write, wrap it, or skip it. The audit still compares
every column with `c.before`, including a write the execute file did its own way.

**Related work stays in the same transaction.** A step receives `c.t` and passes it
on. A query that omits it checks out a second connection and sees only committed
data, so it misses the rows this request just wrote. `c.savepoint(work)` rolls back
only that work. `c.afterCommit(work)` runs after a successful commit, which is where
mail and notifications belong: a rolled-back invoice never sends its email.
`c.get(OtherService).perform(..., c.t)` runs another entity's steps and its own audit
row inside this transaction.

**Later steps see what earlier steps decided.** One `c` is shared. A value that is
not a column goes on `c.state` (declared in `_state.ts`). A column is `c.row.set(...)`.
Replacing `c.row` makes the save, the uniqueness check and the audit follow the new
object. Setting `c.result` is how an endpoint returns something other than the saved
row.

**The screen and the server describe the same action.** Actions live in
`<module>.actions.ts`: name, label, permission, the row state `from` which it starts,
confirm text, kind (`row`, `bulk`, `collection`). `GET /<resource>/actions` is what
the UI draws. `GET /<resource>?actions=1` adds `_actions` on every row:
`{ allowed, reason }`, false when the row is in the wrong state, outside the caller's
scope, over a limit, locked by a guard, or soft-deleted. The button is a hint. The
steps still decide.

**A bulk action cannot half-apply.** `POST /actions/:name` with `{ ids }` checks every
record first and returns blockers per record. Only then do before, the write and after
run, once per record, in one transaction.

**Permissions carry a reach and a ceiling.** A grant is `{ scope, limits }`, not a
boolean. `all`, `branch` and `own` are built in; a project registers more. A scope
both filters lists and decides a loaded row. A limit (approve up to an amount) blocks
with `limit_exceeded` before the steps, per record on a bulk action. The catalog says
which scopes and limits a permission offers; saving a role rejects an unknown code,
a scope that permission does not offer, or a negative limit. The effective set is
cached per company, user and role. Editing a role drops that cache in every process.

**A closed year refuses the ledger row too.** A project rule such as a period lock is
a row guard. The framework runs the guards of an entity before its check steps, and
again on every create, update and delete a step makes on a tenant model, including a
flow step and a service the step calls. A branch-limited user cannot post stock or a
ledger line in another branch. `asSystem(() => work)` lifts the scope for an integrity
write and leaves the guards in place; the call site says why. Writes outside an
operation (sign-in, jobs, migrations) are left alone.

**A request cannot move a row to another company.** On a tenant service, create and
update copy the DTO onto the row without system fields: id, the partition column,
`createdById`, `updatedById`. Hooks fill the partition column on create and pin it on
find, count, bulk update and bulk destroy. A query that reaches another database, or
runs on another tenant's transaction, is refused.

**Tenancy is the request, not an argument.** Models do not take a connection.
`Model.sequelize` and the schema are getters that read the request context, so
`findAll`, `c.t` and raw SQL land in that company's database and schema. Pools start
at `search_path=tenant_unset`; the transaction sets the path locally, which keeps a
connection pooler from pinning a server connection. Unknown company is 404. A company
that is moving, or not active, is 503 on every request. Tokens carry an epoch; a move
bumps it, and old access tokens die. The move itself copies the company's rows into
the target (shared schema or another database), remaps foreign keys, switches the
route, and removes the source. An id column that is neither a real foreign key nor
declared (`@SoftRef`, `@NotARef`, `@Polymorphic`, a reference table) fails boot, so
the mover is not guessing.

**Platform and tenant do not share a query.** Identities, companies, licenses and
sign-in live in the control plane. Invoices, stock and trips live in the tenant. They
talk through contracts: a command or query runs in the handler's own transaction, on
its own plane; an event is written in the emitter's transaction and delivered after
commit, at least once, skipped when the subscriber has already seen it. The same call
is in-process when both sides are in one process, and HMAC-signed HTTP when they are
not. One image, `SERVICES=platform,tenant`. In the cloud the same image runs twice
and each side scales on its own. Retries of a keyed command return the stored result.
A rolled-back invoice never emits `memberConfirmed`.

**Repeated rules can be data, and the compiler still checks them.** A step file may
be code or a flow. A flow is a list of steps written with builders (`Flow.unique`,
`Flow.lookup`, `Flow.createMany`), numbered like every other file, so flows and code
interleave and the number band still keeps checks before writes. Expressions
(`data.qty * data.rate`) compute values and conditions: no data access, no `eval`,
names checked at boot. Field arguments are the model's attributes, so a typo does not
compile. A write inside a check flow does not compile. Boot parses every flow again
and fails with the file and the step position. What is not repetitive stays a method
in the same file (`Flow.call`). A project names its own repeated rules
(`normalizeDecimals`, `financialYearOpen`) so a file reads as the business rule.
Flow reads and writes go through the same scope and the same row guards as code; a
write touching more than 5,000 rows is refused.

**History is free.** Every create, edit, delete and action is audited.
`GET /<resource>/:id/history` is the row's history. The admin panel uses the same
engine on the control plane (`ControlCrudService`): steps, actions, guards, limits
and history, with admin tokens and admin roles.

**A step test does not need Postgres.** `fakeOpContext` and `runSteps` (from
`@ops/framework/testing`) build the same `c` and run a phase. `calls` answers
`c.service()`. `c.emitted` and `c.calls` record what the step sent. `npm test` runs
the framework's own suite with no database. End-to-end specs live in the projects,
one app per file, because models bind once per process.

## What a module looks like

```
src/modules/branches/
  branches.service.ts          entity, toCreate / toUpdate, guards, actions =
  branches.actions.ts          deactivate, activate, bulk, ...
  ops/deactivate/
    _state.ts                  fields later steps will read
    010-check-open-work.ts     read, issues.block / issues.warn
    400-before-stamp.ts        set fields on c.row
    500-execute.ts             optional; replaces the built-in write
    520-after-close-related.ts still inside the transaction
  ops/list/                    shape c.where / c.include / c.order, then decorate rows
  ops/view-usage/              GET /:id/views/usage, read only, sets c.result
```

The service file is configuration. Business logic lives in the step files. A step is
a default-exported object, or an `@Injectable()` class when it needs constructor
injection. `when` skips a step; `describe` is the line the flow document prints.

Lists never load child collections for the grid. A before step narrows `c.where`.
An after step may attach a value computed for the ids on that page. A named view
(`GET /?view=active`) runs `list/` and then `list-active/`.

## What the framework refuses to own

It knows nothing about a project. `defineNames` (from `@ops/framework/names`, imported
first, before any model) sets the control schema, the user table, snake_case versus
camelCase, and the partition column. `FrameworkModule.forRootAsync({ features })`
turns features on: ACL, audit, placement, services, admin, and whether the framework
owns the schema or only checks it. A feature left off registers no table, so a project
with its own schema never meets a framework table.

Period locks, financial years, document numbers and settings stay in the project.
They plug in as row guards and as services a step calls. TMS and Ankpal differ in
column spelling, permission codes and which tables they already had; both run this
engine.

## Using it

Projects install a copy, so Nest, Sequelize and the rest stay one instance (they are
peer dependencies):

```
# .npmrc
install-links=true

# package.json
"@ops/framework": "file:../../ops-framework"
```

After a framework change, `npm run fw:update` in the project rebuilds and reinstalls it.

| Import | What it is |
| --- | --- |
| `@ops/framework` | everything an app uses |
| `@ops/framework/names` | `defineNames`; loads no model |
| `@ops/framework/testing` | `fakeOpContext`, `runSteps` |
| `@ops/framework/internal` | infrastructure tests |

```
npm test          vitest, no database
npm run typecheck
npm run build     ESM and .d.ts in dist/
npm run lint
```

GitHub runs `npm test` on every push and pull request. The badge above is that workflow.

When the framework changes, update [`docs/ops.md`](docs/ops.md) in the same change.
That file is the reference for steps, actions, flows, tenancy, services, migrations,
ACL, guards and the admin plane.
