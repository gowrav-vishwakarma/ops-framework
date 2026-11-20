# Test system playbook: Quasar + desk framework, NestJS + ops-framework

This file tells a developer, and the AI coding agent they hand it to, how to build a complete automated test system for
one product built on:

- **Frontend:** Quasar (Vue 3, TypeScript), using the **desk framework**. It is copied into the project at
  `src/desk/framework/`.
- **Backend:** NestJS, using the **ops framework** (`@ops/framework`, cloned with git for now) with sequelize-typescript
  and Postgres. Redis is optional.

It describes a system that already runs in production on another product. Build the same thing for your product.

**Scope: this is an e2e test system and nothing else.** It has three kinds of tests: **unit** (backend and frontend),
**backend e2e** (with its report) and the **UI auto-tester**. There is **one product and one backend**: no comparison
with a second or legacy backend, no parity checks and no scenario ("stories") tier. If the reference repo shows you a
`scenarios/` folder, parity code or a scenarios page, it is a retired tier: do not build it. Only the few helper files
the e2e report reuses from that folder are copied, as part of the e2e report (section 6.4.15). Every test is pass or
fail.

---

## 0. What you end up with

| Tier | Where | Command | Needs | Proves |
| --- | --- | --- | --- | --- |
| 1. Backend unit | `server/src/**/*.spec.ts` | `npm test` | nothing | each op step and flow, calculations, pure helpers |
| 2. Frontend unit | `frontend/src/**/*.vitest.spec.ts`, `frontend/test/vitest/__tests__/` | `npm test` | nothing | desk calculations, form/grid logic, API mapping, settings combinations |
| 3. Backend e2e | `server/test/*.e2e-spec.ts` | `npm run test:e2e` | Docker stack | every endpoint and business rule over HTTP, on a fresh copy of the database per file; a report page per spec file with every call each test made and the rows each call changed |
| 4. UI auto-tester | `<product>-auto-tester/` (sibling repo or folder) | `npm run test:e2e` | Docker stack + both apps | real screens driven like a person (Playwright, headed), with checks on screen first |

The tiers share these parts:

- **One Docker test stack:** Postgres keeps its data in memory (tmpfs), plus Redis. It uses its own ports, so it never
  touches a developer's or a shared database.
- **One template database:** migrations, plus a company registered **through the product's own endpoints**. Every
  e2e file and every UI run clones it. The first build is slow; afterwards a **local dump cache** restores it
  in seconds.
- **HTML reports:** one folder per run, the newest N kept. A development server shows them at `/api/dev/tests` and
  `/api/dev/e2e` (section 7.1). On a QA server they are switched on by an env flag (section 7.2).
- **The e2e report (section 6.4):** not just pass or fail. For every spec file, one HTML page and one JSON summary:
  what the file proves (its header comment), the settings the app started with, the data its setup made, and for
  every test its state, time and errors, every HTTP call (who sent it, what was sent, what came back, a report's
  answer drawn as a table), the rows each call inserted, updated or deleted (read from Postgres triggers on the
  clone), and the watched figures before and after. `/api/dev/e2e` lists the runs and files by business area.

Build them in the order of section 10. Each step has its own acceptance check.

---

## 1. Rules for the agent (read first, follow always)

1. **Real processes, never SQL inserts.** Test data is made through the product's real endpoints, the same ones the UI
   calls. SQL is only for reading and checking. A test that inserts rows directly proves nothing about the product.
2. **Never a shared or remote database.** Every helper that creates or drops a database refuses any host other than
   `localhost` / `127.0.0.1`, and any name that does not match the test prefix (`^<product>_e2e_[a-z0-9_]+$`).
3. **No secrets in the repo.** Give the names of env variables, never their values. Mail, SMS, S3, payment gateways,
   cron and any outbound call are switched to capture or local mode in tests. Nothing leaves the machine.
4. **Exact answers.** Selection tests (lists, filters, searches, lookups) also seed **decoys**: records that must
   **not** come back. They then assert the **exact set of ids** returned, not "at least one row".
5. **Refusals are tested too.** For every rule, a test checks that the bad input is refused with the right status (422
   with all issues together, 409 for a warning that needs confirmation) and that **nothing changed** in the database.
6. **Settings combinations.** Every company or tenant setting that changes behaviour is tested in each of its values
   that matter, not only the template's default. Keep a generated list of settings and the code that reads them
   (section 7.3), so nothing is missed.
7. **Dates are plain `YYYY-MM-DD` strings** for business dates: no timezone conversion in tests or code.
8. **UI tests check the screen first.** A row has gone from the grid; an issue shows under its field. Use the database
   only for what the screen cannot show.
9. **One spec at a time when it fails.** Fix it, rerun that spec, then the whole tier. Never stack runs on top of each
   other.
10. **Generic helpers go into the frameworks.** Anything that is not product-specific goes into the desk testkit
    (`src/desk/framework/testkit/`) or `@ops/framework/testing`, so the next product gets it for free.
11. **Never commit generated output:** reports, dumps, `test-results/`, `playwright-report/`, `.cache/`,
    `.e2e-run/`. Add all of them to `.gitignore` first.
12. **Each tier has a README** that says how to run it, how to run one test, and how to write a new one.

---

## 2. Tools and versions

| Need | Use |
| --- | --- |
| Unit and e2e runner (both apps) | **Vitest** (`vitest`, `@vitest/ui` for the HTML reporter) |
| Frontend DOM for unit tests | `happy-dom`, `@vue/test-utils`, `@quasar/vite-plugin`, `vite-tsconfig-paths` |
| HTTP calls in backend e2e | `supertest` against `app.getHttpServer()`, or plain `fetch` against a started server |
| Running TS scripts | `tsx` |
| Property tests (calculations) | `fast-check` |
| UI automation | **Playwright** (`@playwright/test`), Chromium, headed by default for people, headless in CI |
| Database access in tests | `pg` (plain client) |
| Docker | `docker compose` (v2), image `postgres:17` (or `pgvector/pgvector:pg17` if you need vectors), `redis:7` |
| Dumps | `pg_dump -Fc` / `pg_restore`, on the host or in the Postgres image (`docker run --network host`) |

---

## 3. The test stack and the template database

### 3.1 Docker compose (`server/test/stack/docker-compose.yml`)

```yaml
name: <product>-e2e
services:
  postgres:
    image: postgres:17
    ports: ['55433:5432']            # never 5432: no clash with a developer's own Postgres
    environment: { POSTGRES_PASSWORD: postgres }
    tmpfs: ['/var/lib/postgresql/data']   # in memory: fast, and gone on stop
    command: ['postgres', '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=300']
    healthcheck: { test: ['CMD', 'pg_isready', '-U', 'postgres'], interval: 2s, retries: 30 }
  redis:
    image: redis:7
    ports: ['56380:6379']
    healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: 2s, retries: 30 }
```

Pick ports per product, so two products' stacks can run side by side.

### 3.2 The stack script (`server/test/stack/stack.ts`, run with `tsx`)

The commands, as npm scripts:

```
npm run stack:up             # compose up --wait; reuse it when the port already answers
npm run stack:down           # compose down (this project's containers only)
npm run db:template          # template exists → keep; else cached dump → restore (seconds); else build from scratch + save dump
npm run db:template -- --rebuild   # build again from scratch and replace the dump (after new migrations)
npm run db:template:save     # refresh the dump from the template as it is
```

**Build from scratch:**

1. Create `<product>_e2e_template`.
2. Run **all migrations** (or the ops framework's schema sync, if the product owns its schema that way).
3. Seed what a fresh install seeds (default roles, plans, lookup data) through the real seeders.
4. Start the backend on the template, with a `NODE_ENV` that turns the test-only endpoints on.
5. **Register a company through the HTTP API.** There is a test-only "register and verify" endpoint (section 3.4); then
   activate the licence or plan through the admin endpoint if the product has one.
6. Stop the backend. Terminate its connections, so the database can be used as a `TEMPLATE`.

Keep the result deterministic: fixed owner email (`e2e.owner@<product>.test`), fixed password, fixed company name and
fixed `branch` / `financial year` codes, so every test can sign in the same way.

**The local dump cache:**

- It lives at `~/.cache/<product>-e2e/<template>.dump` plus `<template>.json`
  (`{ savedAt, template, migrations, bytes }`). It is on the developer's machine only, never in git.
- `migrations` is a fingerprint: sha256 over the sorted migration files (path + content) and the seed or bootstrap
  script.
- On restore, if the fingerprint differs, **warn** ("migrations changed since this dump, run `--rebuild`") but still
  restore. The developer decides when to rebuild.
- Restore means: terminate connections, `DROP DATABASE`, `CREATE DATABASE`, then
  `pg_restore --no-owner --exit-on-error`. Measured: about 2 s for a template with about 600 tables.
- Use `pg_dump` / `pg_restore` from the host when installed, else
  `docker run --rm -i --network host -e PGPASSWORD=… postgres:17 pg_restore …`, with the dump piped on stdin.
- **CI and QA servers never use the cache.** They build from scratch on every run, from the migrations of that commit.

### 3.3 Cloning (`server/test/support/e2e-db.ts`)

```ts
export async function cloneTemplate(name: string): Promise<string> {
  if (!/^<product>_e2e_[a-z0-9_]+$/.test(name)) throw new Error(`Refusing database name ${name}`);
  // admin(): connects to `postgres` on the test host only (refuses anything but localhost / 127.0.0.1)
  await admin(async (client) => {
    const found = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEMPLATE]);
    if (!found.rowCount) throw new Error(`No ${TEMPLATE}. Run: npm run stack:up && npm run db:template`);
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [TEMPLATE]);
    await client.query(`DROP DATABASE IF EXISTS "${name}"`);
    await client.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE}"`);
  });
  return uriOf(name);
}
```

Also add `dropDatabase(name)`, and `dropLeftoverClones()`, which drops every `<product>_e2e_*` database nobody is
connected to, the template excepted. Call it from each tier's global setup, so the in-memory Postgres never fills up
after a crashed run.

### 3.4 Test-only endpoints (backend)

Registration normally needs an email OTP. Add a module that is **only imported when
`NODE_ENV in ('development', 'test')`**, or when an explicit flag is set:

- `POST /api/test/register` → registers and verifies in one call. The body chooses the tenancy if the product has more
  than one: a shared schema, or the company's own schema.
- The same check also guards any other shortcut a test needs (reading the captured mail or OTP, moving a clock).

Write an e2e spec that proves these endpoints **do not exist** with `NODE_ENV=production` (404).

If a new company gets its own schema by cloning a base schema (for example `tenant1`), test that the clone has every
table and the migrations table rows of the base. Otherwise later migrations skip those companies.

---

## 4. Tier 1: backend unit tests (ops framework)

- Vitest config `server/vitest.config.ts`: `include: ['src/**/*.spec.ts']`. Inline `@ops/framework`
  (`server: { deps: { inline: ['@ops/framework'] } }`), so its decorators and ESM resolve the same way as in the app.
- The ops framework ships testing helpers at `@ops/framework/testing`: `fakeOpContext`, `runSteps` and `runFlow`.
  Check the package's `docs/ops.md` for the current list.
- What to test:
  - **Each check step:** given a row, dto and state, the right `issues.block` / `issues.warn` with the right field and
    message, and nothing when valid.
  - **Each before/after step:** what it sets on `c.row` / `c.state` and what it asks to write.
  - **Flows** (`flow({...})` files): `runFlow(flow, fakeOpContext({...}))`. Also test that a bad flow fails at boot,
    with the file path.
  - **Calculations** (totals, taxes, rounding, stock cost): table-driven cases plus `fast-check` properties (totals
    never negative, a line's sum equals the header, a round trip is stable).
  - **Settings matrix:** for each setting a calculation reads, one case per value that matters.
- Keep each spec next to the file it tests (`thing.ts` → `thing.spec.ts`).

```ts
import { fakeOpContext, runSteps } from '@ops/framework/testing';
import checkUniqueName from './ops/save/010-check-unique-name.js';

it('refuses a duplicate name', async () => {
  const c = fakeOpContext({ dto: { name: 'Freight' }, count: async () => 1 });
  await runSteps([checkUniqueName], c);
  expect(c.issues.blocks).toEqual([{ field: 'name', message: expect.stringMatching(/already/) }]);
});
```

---

## 5. Tier 2: frontend unit tests (desk framework)

- Vitest config `frontend/vitest.config.mts`:
  - `environment: 'happy-dom'`
  - `setupFiles: 'test/vitest/setup-file.ts'` (installs Quasar for `@vue/test-utils`)
  - plugins `vue()`, `quasar({ sassVariables })`, `tsconfigPaths()`
  - include `src/**/*.vitest.spec.ts` and `test/vitest/__tests__/**/*.spec.ts`
- **Move logic out of components into plain `.ts` files** (calculations, line defaults, payload builders, lookup column
  definitions, error mapping), then unit-test those files. A component test is only for wiring: the form shows the
  issue, the grid runs the action.
- Must-haves:
  - The **API layer** (`resource.ts`, `errors.ts`): 422 maps to field issues, 409 to a confirm, and the right URL and
    body per call.
  - **Calculations the UI shows before saving** use the same cases as the backend's, so the screen and the saved
    document agree. Keep the cases in one shared fixture (YAML or JSON). Both apps' tests read it, and a third test
    compares the two engines (section 5.1).
  - **Every company-setting combination** that changes a screen's calculation or what it shows.
- Run with `npm test` (`vitest run`). Coverage: `vitest run --coverage` (v8).

### 5.1 Calculation agreement (optional but recommended)

If the frontend computes figures before saving (totals, taxes), add a test that runs the **same cases** through:

1. the desk's calculation,
2. the backend's calculation (called in process, or through a preview endpoint),
3. the hand-checked expected numbers.

All three must agree within the smallest currency unit. Add `fast-check` generated cases for desk vs backend. The
auto-tester's `calc/` folder (section 8.2) is a good home when it can import both apps; otherwise put it in `server/`.

---

## 6. Tier 3: backend e2e (`server/test/*.e2e-spec.ts`)

### 6.1 Config (`server/vitest.config.e2e.ts`)

```ts
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const reportDir = join(import.meta.dirname, 'test', 'reports', stamp);
export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    server: { deps: { inline: ['@ops/framework'] } },
    globalSetup: ['./test/support/global-setup.ts'],   // drop leftover clones, prune old reports
    setupFiles: ['./test/support/trace/trace-hooks.ts'],   // the e2e report's hooks (6.4.6)
    env: { E2E_REPORT_DIR: reportDir },                // where the hooks write tests/<slug>.html and .json
    fileParallelism: false,                            // each file boots one app on its own clone
    reporters: ['default', ['json', { outputFile: join(reportDir, 'results.json') }]],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
```

No Vitest HTML reporter: the report pages are written by the trace (section 6.4). `results.json` (Vitest's JSON
reporter) gives the run's totals and failures.

Global setup: `dropLeftoverClones()`, then delete report folders beyond the newest `E2E_KEEP_RUNS` (default 10).

### 6.2 Booting the app per file (`server/test/support/e2e-app.ts`)

```ts
export async function bootApp(label: string, env: Record<string, string> = {}) {
  const name = `<product>_e2e_${label}_${Date.now().toString(36)}`;
  const uri = await cloneTemplate(name);
  clearHostDatabaseEnv();            // a developer's shell exports (TENANT_DB_URI_*, DATABASE_URI…) never reach a test
  Object.assign(process.env, stackEnv(uri, env));   // test/support/stack-env.ts: the complete test environment
  const { AppModule } = await import('../../src/app.module.js');
  const { configureApp } = await import('../../src/main.js');   // the same pipes, prefix, filters as production
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = module.createNestApplication({ logger: ['error', 'warn'] });
  configureApp(app);
  await app.init();
  return { app, uri, close: async () => { await app.close(); await dropDatabase(name); } };
}
```

- **No developer settings in tests.** `stackEnv(uri, extra)` (`test/support/stack-env.ts`) is the complete environment
  of every app a test boots (in process, the built server, the template build): `IGNORE_ENV_FILE=true` (the app's
  `ConfigModule.forRoot({ ignoreEnvFile })` skips `.env`), every database it may reach is the clone (`DATABASE_URI`
  **and** every per-database key such as `TENANT_DB_URI_primary`), the JWT settings, Redis per spec, Mongo / mail / OTP
  / S3 off. `vitest.config.e2e.ts` also sets `IGNORE_ENV_FILE=true` in `test.env`, before any import. A system check
  fails when any value from the developer's `.env` shows up in the test process. Why: a developer whose `.env` named
  his own local `TENANT_DB_URI_primary` had the registration copy read his local database (wrong migration list).
- `main.ts` exports `configureApp(app)`, so the tests and production share one setup (global prefix, validation pipe,
  exception filter, CORS).
- `bootApp` also attaches the e2e trace (change log on the clone, call recorder on the app) before `configureApp`,
  and detaches it in `close` before the clone is dropped. Section 6.4.3 shows the exact lines.
- Add a `signIn(app, email, password)` helper that goes through the real login (and company switch) endpoints and
  returns the headers. Add a `clerk` helper per role (owner, a limited role) that is created through the real
  user-invite and role endpoints. ACL is tested with these users, not with forged tokens. Forge a token only to test
  the guard itself (a revoked, expired or wrong-audience token).

### 6.3 What every module's spec covers

For each entity or module:

1. **List:** paging, sort, filters, search. Use decoys and assert exact id sets.
2. **Create:** a valid create; each refusal (422, all issues at once, the field names); nothing written after a refusal.
3. **Update:** edit locks (fields that cannot change after use) and optimistic conflicts if any.
4. **Delete:** blocked when the record is referenced (`dependents`); allowed otherwise; the history row exists.
5. **Each action:**
   - `row`: the allowed `from` states, a confirm (409) then `confirm: true`;
   - `bulk`: blockers are reported per record, and nothing changes when any record is blocked;
   - `collection`.
6. **ACL:** allowed, denied (403), branch-scoped (only the user's branches come back).
7. **Tenancy:** company A cannot read, change or reference company B's rows (404 or 422, never data).
8. **Audit:** `GET /<resource>/:id/history` lists the create, edit and action.
9. **Undo:** deleting or cancelling a document fully reverses its effects (stock, balances, links). Assert the figures
   return exactly to before.
10. **Settings:** each setting that changes this module's behaviour, in each of its values.
11. **Bad bodies:** unknown fields, wrong types and missing required fields are refused by the DTO (400 or 422), never
    a 500.

Read figures (balances, stock, counts) with small SQL helpers, `figure(app, sql, params)`. Read only; never write.

### 6.3.1 A request's life: abort, time slots, idempotent saves (one spec for the whole app)

The framework stops a read whose caller left, stops any request over its time slot (503 `timeout`, a write rolled
back) and runs a save sent with `Idempotency-Key` once (ops-framework `docs/ops.md`, "A request's life"). Prove it once,
on a real Postgres, in one system spec (Ankpal: `test/system/requests.e2e-spec.ts`):

- **Test-only slow endpoints** (the §3.4 guard): a slow read through the normal read path (a list whose before step
  runs `pg_sleep` with a marker in its SQL, and whose after step records that it ran) and a slow write (a create whose
  after step sleeps inside the save's transaction). Shorten the fast slot for that file only (an env setting such as
  `REQUEST_SLOT_FAST_MS=5000`) so an overrun takes seconds.
- **Abort:** start the slow read, find its statement in `pg_stat_activity` by the marker and read its tag
  (`/* r:<id> */`), drop the connection (`call.abort()` on a started supertest call); within a second no active
  statement carries the tag, the after step never ran (check after the sleep would have ended), a **decoy** slow read
  started beside it answers 200 with all its steps, and then more reads at once than the pool has connections all
  answer (the pool is unharmed).
- **Writes:** a slow write whose caller leaves still commits (poll the record through the API); a write over its slot
  answers 503 `{ code: 'timeout' }` near the slot's length and its row is not there.
- **Idempotency on a real document save** (a payment or an invoice): the same key twice → one document, equal
  answers, the second with `Idempotent-Replayed: true`; the same key at once → one saves, the other 409
  `save_in_progress` or the replay, then a replay; deterministic 409 while the slow write holds the key; the same key
  with another body → 422 `idempotency_key_reused`, nothing saved; two keys → two documents; another user with the
  same key → their own save; a failed first save (400) frees the key for the corrected one; no key → as before; a key
  that is not a UUID → 400; a read ignores the key. Count documents with read-only SQL by their number.
- **Framework unit tests** (no database): the step runner stops before the next step once the signal fired; a
  request's statements carry its tag (request, company, operation, step file; `*/` in a value broken up) and nothing
  outside a request does, the patch of Sequelize's `Query.run` installed once (a fake query class); a transaction's start
  carries `SET LOCAL statement_timeout` (never a session `SET`: it pins RDS Proxy connections); the cancel SQL matches
  only that request's tag and never its own connection; slot resolution (route, controller, CRUD operation, action);
  the idempotency store's states against a fake Redis (first, running, replay, reused, released, expired); uploaded
  files are part of what is compared (a multipart save with another file and the same key: 422, in the e2e).
- A fake Postgres in unit tests must match statements **after leading comments** (Postgres skips them), or every
  request's tag breaks its matchers.

### 6.4 The e2e report (what every test did)

Pass or fail is not enough to trust a test. The e2e report shows, per spec file and per test, **every HTTP call the
test made and every row each call changed in the database**, so a reader sees what "passed" really covered and what a
failing call did. It is written by our own code (the "trace"), not by a Vitest reporter. Build it exactly as below;
the reference code lives in `server/test/support/trace/` and `server/src/dev/tests/e2e-*.ts`.

Besides its own files, the trace uses a few **report helpers**: the trigger change log and its folding
(`row-changes.ts`, `table-keys.ts`, `table-rows.ts`, 6.4.5), the "Tables changed" HTML (`row-changes-html.ts`), value
formatting (`values.ts`), the settings section's style (`settings-html.ts`), the figure reading type (`Reading`) and
the read-only `Sql` interface. In the reference repo they still live under `scenarios/runner/` (a leftover of the
retired scenarios tier, see the top of this file) and the trace imports them from there. In your product they are part of the e2e report: put them with it, in `server/test/support/trace/`. The
list, with what to keep from each, is in 6.4.15.

#### 6.4.1 The pipeline, end to end

1. **Docker stack** up (3.1), **template database** built (3.2): migrations, the install seeds, then a company
   registered **through the app's own endpoints**; saved as a local dump and restored in seconds afterwards.
2. `vitest.config.e2e.ts` computes the run's stamp (UTC, 14 digits, `YYYYMMDDHHMMSS`) and folder
   `test/reports/<stamp>/`, and passes it to the workers as `E2E_REPORT_DIR`. The global setup drops leftover clones
   and prunes old run folders (6.4.12).
3. Files run one at a time (`fileParallelism: false`). Each spec file's `beforeAll` calls `bootApp(label)`:
   - `cloneTemplate` makes `<product>_e2e_<label>_<base36 time>` from the template (3.3);
   - the env is set (test secrets, mail and SMS to capture, local files, Redis per file or off);
   - the tracer **attaches**: it opens its own connection to the clone and installs the change log (triggers) there;
   - the app is created, the recorder middleware is added, `configureApp(app)`, `app.init()`;
   - the tracer reads the **settings the app starts with** (6.4.9), before the file's own setup.
4. Each call a test makes goes through the recorder middleware: method, path, status, time, caller, masked body and
   answer are kept, and before the answer is let out, the rows the call changed are read from the change log
   (6.4.4, 6.4.5).
5. The setup file's hooks cut the stream into entries: whatever happened before a test (the file's `beforeAll`) is a
   **setup** entry; each test is a **test** entry with its calls, its "after the calls" rows, its figures and checks
   (6.4.6).
6. After the file, the hooks read each test's final state from Vitest, then write `tests/<slug>.html` (the page)
   and `tests/<slug>.json` (the summary) into the run folder (6.4.7, 6.4.8).
7. The spec's `afterAll` calls `e2e.close()`: payload warnings saved (6.4.14), app closed, tracer detached (its
   connections to the clone closed), Redis keys of the file dropped, clone dropped.
8. When all files are done, Vitest's JSON reporter writes `results.json`. Until then the run shows as "running or
   stopped" and its finished files are already listed.
9. The dev server's `/api/dev/e2e` lists the kept runs and each spec file's latest result, ordered by the business
   area from each spec's `Area:` line, and serves the pages and files (6.4.11).

#### 6.4.2 The run folder

```
test/reports/                      gitignored; newest E2E_KEEP_RUNS (default 10) kept
  20261119015436/                  one run (UTC stamp)
    results.json                   Vitest JSON reporter: totals, every test's status, failure messages
    tests/
      tenant__account.e2e-spec.html    one page per spec file (self-contained: inline CSS and JS)
      tenant__account.e2e-spec.json    its summary (6.4.7)
      admin__admin-auth.e2e-spec.html
      ...
    payload-warnings/<label>.json  only with PAYLOADS_STRICT=warn and when there were any (6.4.14)
    servers/<label>.log            only with E2E_TARGET=built: each file's server log
```

The slug is the spec path without `test/` and `.ts`, every other character run turned into `__`:
`test/tenant/account.e2e-spec.ts` → `tenant__account.e2e-spec`. Sizes, for scale: about 120 spec files and 1,240
tests give a 150 MB folder; one page is 0.2 to a few MB.

A run's **zip** is this folder as it is. The pages need nothing else to open (inline style and script, no external
files), so zipping `test/reports/<stamp>/` gives a report anyone can open offline. Only the "all files of this run"
link at the top of a page points at the dev server's run page. If you want a download button, add
`GET /api/dev/e2e/download?run=<stamp>` that zips the folder with `fflate`'s `zipSync` (stamp checked as 14 digits,
the same path guard as the report files).

#### 6.4.3 Attaching the tracer (`test/support/trace/tracer.ts`, `test/support/e2e-app.ts`)

`tracer` is one module-level instance per spec file (Vitest isolates modules per file). In `bootApp`, in process:

```ts
const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
const app = module.createNestApplication({ logger: ['error', 'warn'] });
app.use(writeWatcher);                 // optional repeat guard (6.4.13)
if (traceOn()) {                       // traceOn = () => process.env.E2E_TRACE !== '0'
  await tracer.attach(uri);            // RowLog.open(uri): own pg connection, installs the change log
  app.use(tracer.middleware);          // before configureApp: it must see every route
}
configureApp(app);
await app.init();
if (traceOn()) {
  tracer.server = app.getHttpServer(); // the figures call the app through it (6.4.10)
  await tracer.readStartSettings(uri, app, testEnv);
}
// close(): savePayloadWarnings(label); await app.close(); await closeFigureTools(uri);
//          await tracer.detach(); drop the file's Redis keys; await dropDatabase(name);
```

The middleware is added with `app.use` before the body parsers run, so it reads the parsed body only when the answer
ends (by then the parsers and multer have run).

**Against the built server** (`E2E_TARGET=built`, optional: the same specs against `node dist/main`): each file starts
the built server on its clone (a free port, its log to `servers/<label>.log`), and an Express **proxy in the test
process** that runs, in order, the session seeder (if any), the write watcher, the tracer's middleware, then
`express.raw({ type: () => true })` and a forwarder (`fetch` to the server, the answer copied back). Supertest targets
the proxy. The recorder then sees raw bodies and parses them itself (JSON, urlencoded, otherwise
`<N bytes of type>`). Specs that need the app's services (`app.get`) or its in-memory captures (mail, OTP) are listed
in `test/support/in-process-only.ts` with the reason, and the config excludes them in a built run.

**`E2E_TRACE=0`** boots apps without the trace: no change log, no recorder, no figures. The hooks still run, so every
file still gets its page and JSON with each test's state, time and errors, and every entry notes "calls and rows not
traced (E2E_TRACE=0)". Use it for a fast run; the default is on.

#### 6.4.4 Recording every call (`test/support/trace/http-calls.ts`)

`recordCalls(hooks)` returns an Express middleware. For each request:

1. Note the start time; wrap `res.write` and `res.end` to keep the answer's bytes (up to 256 KB; beyond that the
   text is cut with "answer cut at …").
2. Call `hooks.started()` (async) and only then `next()`, so the app sees the request after the tracer set aside
   rows written between calls.
3. When the app calls `res.end`, **hold the end**: compute `ms`, await `hooks.answered()` (which settles and reads
   the call's rows), push the call record, and only then call the real `end`. The test cannot send its next call
   before this call's rows are read, so work the app does after answering (after-commit) is counted in this call.

The record:

```ts
interface HttpCall {
  method: string;
  path: string;          // req.originalUrl with secret-named query values masked (?token=***)
  status: number;
  ms: number;            // until the app ended the answer (row reading not included)
  caller?: string;       // from the bearer token's claims, decoded not verified:
                         // 'owner@<product>.test · owner · company 1 · branch 1', 'no token', 'unreadable token'
  body?: unknown;        // parsed JSON or form fields, masked; uploads as { ..., '(files)': [names] }
  answer?: unknown;      // parsed JSON (masked) | text for text/xml/html/csv | '<N bytes of type>' otherwise
  tables?: TableChange[];// the rows this call changed (6.4.5)
  rowsNote?: string;     // why there are none of its own: 'ran beside another call: …', 'rows not read: …'
}
```

Pick the caller's claims for your token (email, role, company, branch or employee); the line tells a reader which
user and tenant made the call, which matters for ACL and tenancy tests.

Calls carrying the header `x-e2e-watch` (the figures' own reads, 6.4.10) skip the recorder entirely.

#### 6.4.5 The rows each call changed (`test/support/trace/row-log.ts`)

The change log is a set of Postgres triggers that write every changed row into one table, `scn.changes` (the schema
name is the one the reference code uses; keep it, or rename it everywhere in `row-changes.ts` and `row-log.ts`). The
trace installs it **on each file's clone, in `tracer.attach`**, through its own `pg.Client` with
`application_name: 'e2e-trace'`. Never on the template.

The SQL (`installRowChangeLog` in `row-changes.ts`):

```sql
CREATE SCHEMA IF NOT EXISTS scn;
CREATE TABLE IF NOT EXISTS scn.changes (id bigserial PRIMARY KEY, tbl text NOT NULL, op text NOT NULL, old jsonb, new jsonb);
CREATE OR REPLACE FUNCTION scn.log_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO scn.changes (tbl, op, old, new) VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, TG_OP,
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END, CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION scn.log_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO scn.changes (tbl, op) VALUES (TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, 'TRUNCATE'); RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION scn.watch(s text, t text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS scn_log ON %I.%I', s, t);
  EXECUTE format('CREATE TRIGGER scn_log AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION scn.log_change()', s, t);
  EXECUTE format('DROP TRIGGER IF EXISTS scn_truncate ON %I.%I', s, t);
  EXECUTE format('CREATE TRIGGER scn_truncate AFTER TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION scn.log_truncate()', s, t);
END $$;
-- an event trigger watches tables created during a test (e.g. a new tenant schema)
CREATE OR REPLACE FUNCTION scn.on_new_table() RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT n.nspname, c.relname FROM pg_event_trigger_ddl_commands() d
             JOIN pg_class c ON c.oid = d.objid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE d.object_type = 'table' AND c.relkind IN ('r','p') AND NOT c.relispartition
              AND n.nspname NOT IN ('pg_catalog','information_schema','scn') AND n.nspname NOT LIKE 'pg\_%'
  LOOP PERFORM scn.watch(r.nspname, r.relname); END LOOP;
END $$;
CREATE EVENT TRIGGER scn_new_tables ON ddl_command_end WHEN TAG IN ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
  EXECUTE FUNCTION scn.on_new_table();
-- then: PERFORM scn.watch(schema, table) for every existing table of every schema except the ignored ones
```

- **Watch every schema** (control schema, shared tenant schema, dedicated tenant schemas, `public`), not just one.
- **Ignore only noise**, each entry with its reason, in `table-rows.ts` (`IGNORED`): the migrations table, sessions or
  tokens, OTP sessions, login logs, internal logger tables.
- **Keys:** `table-keys.ts` reads primary and foreign keys from `pg_constraint` (cast names with `::text`) into a key
  cache; a table first seen mid-file (made by the event trigger) refreshes the cache.
- If new tenants get their schema by copying a base schema (a `clone_schema` function that copies triggers too), drop
  the log triggers from the base schema after installing, otherwise each copied table gets the log trigger twice.

This is the main way to see what a call really did, including side effects nobody wrote an assertion for.

`RowLog` has four methods:

- `position()`: `SELECT max(id) FROM scn.changes` (0 when empty; every `take` empties it).
- `take()`: `WITH taken AS (DELETE FROM scn.changes RETURNING …) SELECT … ORDER BY id`, then fold per table and
  primary key (`takeRowChanges` in `row-changes.ts`): a row touched several times shows once, as its state before →
  after; a row that ended as it was is dropped; a changed row keeps only its changed columns, `updatedAt` ignored.
  Keep at most **100 rows per table** per call or test; the counts (added, removed, changed, truncated) stay
  complete. Mask secrets in every `before` and `after`.
- `settle()`: poll every 5 ms one query that returns `max(scn.changes.id)` and the number of busy connections on the
  clone (`pg_stat_activity` for `current_database()`, `backend_type = 'client backend'`, not this connection, not
  `application_name = 'e2e-trace'`, state `active` or `idle in transaction`). Settled when nothing is busy and the max
  id has not moved for `E2E_TRACE_QUIET_MS` (default **10 ms**); gives up after 5 s. Returns the milliseconds waited.
  Settling is what makes async work belong to the call that started it: without it, after-commit work (mails,
  recalculations) lands in the next call and the page lies. The reference does not check queues; if your product runs
  work in a queue, also wait until no job is active (BullMQ: `LLEN` / `ZCARD` of the active lists under the file's
  Redis prefix).
- `close()`.

Every other connection the trace opens on the clone (start settings, figures) also uses `application_name:
'e2e-trace'`, so settling never waits on the trace itself.

The tracer's hooks for the recorder:

```ts
started: async () => {
  this.inFlight += 1;
  if (!this.log || this.inFlight > 1) return false;                 // not the only call: no rows of its own
  if (await this.log.position()) this.loose.push(...(await this.log.take()));  // written between calls
  return true;
},
answered: async (own) => {
  try {
    if (!this.log) return {};
    if (!own || this.inFlight > 1) return { rowsNote: 'ran beside another call: its rows are under "after the calls"' };
    if (!(await this.log.position())) return {};                   // wrote nothing: one query each side
    await this.log.settle();
    return { tables: await this.log.take() };
  } finally { this.inFlight -= 1; }
},
```

- A call that wrote nothing costs two tiny queries. A call that wrote waits for the app to go quiet, then its rows are
  read.
- **Calls in parallel** (`Promise.all` in a test) have no rows of their own: each gets the note, and their rows land
  in the test's **"after the calls"**.
- Rows written between calls, or by work that outlived a call's settle, also go to "after the calls" (`loose`, plus
  whatever is still in the log when the test is cut).

#### 6.4.6 Cutting the stream into tests (`test/support/trace/trace-hooks.ts`)

A Vitest **setup file** (so it runs in every e2e file without the specs importing it) registers root hooks:

- `beforeEach`: `tracer.cutSetup(fullName(test), readFigures)`: whatever was recorded since the last cut (the
  file's or a group's `beforeAll`) becomes a **setup** entry named `setup, before: <test full name>`, only if it made
  calls or rows. It also restarts the test timer and clears stray checks.
- `afterEach`: `tracer.cutTest({ name, fails, errors }, readFigures)`: settles, takes the remaining rows as "after
  the calls", reads the figures, and stores a **test** entry; it keeps the entry by Vitest task id.
- `afterAll(({}, file) => …)` (Vitest 4 passes the file as the second argument): walk every test of the file, set its
  final `state` (`pass` / `fail` / `skip` / `todo`, read only now so an `it.fails` that failed as expected is `pass`),
  its errors (message, diff and stack, terminal colour codes stripped) and its Vitest duration; tests that never ran
  (skipped, todo, or stopped by a failing `beforeAll`) are added after the ones that ran. Then write the page and the
  summary (only when `E2E_REPORT_DIR` is set and there is at least one entry).

Full names are `describe > inner describe > test`. Work done in a spec's own `beforeEach` lands in the test's entry;
work done in an `afterAll` is not shown (nothing cuts after it).

The entry kept per test or setup:

```ts
interface TestTrace {
  index: number;                 // 1, 2, … in the file: the page anchor #t<index>
  kind: 'test' | 'setup';
  name: string;
  state?: 'pass' | 'fail' | 'skip' | 'todo';
  fails?: boolean;               // it.fails: "not built yet"
  errors?: { message: string; diff?: string; stack?: string }[];
  ms?: number;
  settleMs?: number;             // how long the app was still busy after the last answer
  calls: HttpCall[];
  afterCalls: TableChange[];     // rows no call owns
  note?: string;                 // 'rows not read: …' (clone gone) or 'calls and rows not traced (E2E_TRACE=0)'
  checks?: { what: string; count: number; columns: string[]; rows: unknown[][] }[];   // checked(), first 20 rows
  figures?: { before?: Readings; after?: Readings };                                  // watch(), 6.4.10
}
```

How a state is shown everywhere (pages, lists, verdicts): setup → "setup"; `fails` and passed → "not built (fails as
expected)" (grey); `fails` and failed → "not built, but passes now" (red: the decision is built, remove `.fails`);
`fail` → "failed"; `skip` / `todo` → "skipped" / "todo"; else "passed".

#### 6.4.7 The per-file summary (`tests/<slug>.json`)

Small, so the list pages read hundreds of them quickly. Types in `src/dev/tests/e2e-traces.ts` (shared by the hooks
and the dev pages):

```ts
interface E2eFileTrace {
  file: string;        // spec path relative to the repo
  page: string;        // '<slug>.html'
  ms?: number;         // the file's time
  ranAt?: string;      // ISO, when the file started
  title?: string;      // the top describe's title
  summary?: string;    // the header comment's prose, one paragraph
  data?: string[];     // the header comment's data and decoy lines
  groups?: string[];   // the inner describes, in order
  tests: { index: number; kind: 'test' | 'setup'; name: string; state?: string; fails?: boolean;
           ms?: number; calls: number; tables: string }[];   // tables: 'Products +2, Ledgers ~1 −1'
}
```

Example (shortened):

```json
{
  "file": "test/tenant/final-accounts.e2e-spec.ts",
  "page": "tenant__final-accounts.e2e-spec.html",
  "ms": 4344,
  "ranAt": "2026-11-19T02:03:20.199Z",
  "title": "final accounts",
  "summary": "The final accounts, through the APIs only, over two years and a year end. Each view has exact figures; the trial balance and the balance sheet balance in every one.",
  "data": ["2025-26  opening stock 20 @ 50; bought 10 @ 60; sold 15 @ 100; bank charges 100 at the head office, 70 at North (a branch decoy)."],
  "groups": ["within one year (2025-26)", "after the year end"],
  "tests": [
    { "index": 1, "kind": "setup", "name": "setup, before: final accounts > within one year (2025-26) > profit & loss: …", "calls": 15,
      "tables": "Accounts +5 ~1, Products +2, PurchaseInvoices +1, SalesInvoices +2, StockInventories +2 ~2" },
    { "index": 2, "kind": "test", "name": "final accounts > within one year (2025-26) > profit & loss: …", "state": "pass",
      "ms": 78, "calls": 2, "tables": "" }
  ]
}
```

`tables` in short: each table without its schema, `+added ~changed −removed` (and `truncated`), summed over the
entry's calls and its "after the calls".

#### 6.4.8 The per-file page (`tests/<slug>.html`, `test/support/trace/trace-page.ts`)

Plain HTML, one string, inline CSS (the dev pages' shared stylesheet `src/dev/report-style.ts` plus the "Tables
changed" styles of `row-changes-html.ts`, light and dark colours) and two tiny inline scripts (relative times,
expand/collapse). Top to bottom:

1. **Title** (the top describe) and **what the file proves**: the header comment's paragraphs, with its data and
   decoy lines as a list where the comment has them (6.4.9).
2. **Meta line:** spec path, when it ran ("3 min ago"), N tests in S seconds, N calls, a link to the run's page.
3. **Totals:** "N passed · N failed · N skipped or not built", and "expand all / collapse all" buttons.
4. **"Settings the run started with"** (closed): one folded section per source, each a key → value table with nested
   JSON flattened to dotted keys (6.4.9).
5. **"Data the file made before its tests"** (closed): per setup entry, the rows it added in the tables a reader
   reasons about (masters, documents), with telling columns, ids of things the file made shown by name; the other
   tables as one count (6.4.9).
6. **Every entry, in order,** with a group header (the inner describe) above the first entry of each group. Each
   entry is a `<details id="t<index>">`, **open when failing**, with a coloured left border (pass, fail, grey for
   setup and skipped). Its summary line: number, the test's own name, state badge, "N ms · N calls · N checks", and a
   "changed data" badge when any row changed. Inside:
   - **errors:** message, assertion diff, the stack folded; an expected failure (`it.fails`) is folded under "Expected
     failure (not built yet)";
   - notes: the entry's `note`; "The app was busy N ms after the last answer" when `settleMs` > 200;
   - **figures:** a table "Figure | | Before | After | Change" with only the changed values, numbers with a signed
     delta; unchanged figures folded ("N figures unchanged"); or "No watched figure changed";
   - **checks:** "Checked: <what> (N rows)" and the first rows as a table (`checked()`, 6.4.10);
   - **calls**, each a `<details>`: number, method and path, status (red when ≥ 400), ms, "as <caller>", "changed
     data". Opened: the answer drawn as a **report table** when it is a report (below), then two columns **Sent** and
     **Answer** (pretty JSON, masked, cut at 12,000 characters), the rows note, and **"Tables changed: Products +1,
     StockLots +1 ~2"**: the tables as buttons, each showing its rows (an added or removed row whole, a changed row as
     column: before → after; a changed JSON column path by path);
   - or "No HTTP call" (with checks: "it reads rows the tests above wrote");
   - **"After the calls"**: the rows no call owns, in the same "Tables changed" form.

**Report tables** (`report-table-html.ts`): when a call's answer is a report, draw it as the user would read it, up
to 200 rows, numbers right-aligned, decimal strings trimmed, midnight timestamps shown as the day, a bold totals line.
The reference recognises, by shape: the generic report runner's answer (`{ columns: [{ name, label }], rows, totals,
meta: { report } }`), a trial balance tree (`heads` with `children`, indented by depth), a ledger statement
(`transactions` + `totals`: opening, lines, closing), a few list reports by path (`rows`), and any answer made of
sections of `heads` trees (profit and loss, balance sheet). Anything else returns '' and only the JSON shows. Write
one small drawer per report shape your product has.

The dev server adds one thing when it serves a page (6.4.11): a fixed checkbox "Close the previous one when opening
another" (on by default, kept in `localStorage`, wrapped in try/catch), so opening a test closes the previous one.

#### 6.4.9 What the page reads besides the calls

**The spec header** (`spec-doc.ts`, read from the spec's source at report time). Every spec starts with a doc comment
right above its top `describe`:

```ts
/**
 * The final accounts, through the APIs only, over two years and a year end:
 *   2025-26  opening stock 20 @ 50; bought 10 @ 60; sold 15 @ 100; bank charges 100 at the head office,
 *            70 at North (a branch decoy).
 *   Decoys: a sale after the period, a cancelled sale.
 * Each view has exact figures; the trial balance balances in every one.
 *
 * Area: reports / final-accounts
 */
describe('final accounts', () => {
```

- Prose lines make paragraphs (a blank line splits them).
- A **data line** is a line indented 2+ spaces or starting with a short label and a colon (`A: …`, `Decoys: …`); a
  deeper-indented line continues the item above.
- The **`Area: <area> / <topic>`** line is not shown in the text; it places the file in the lists (6.4.11).
- Title: the top `describe`'s name.

**Start settings** (`start-settings.ts`, `start-settings-html.ts`): read once per file right after the app booted,
before the file's setup, on its own read-only connection (masked, `id` / timestamps / partition column left out).
Sources in the reference: the company settings tables (one row as is, several keyed by company), the licence or plan
as the app computes it (through an app service in process; from the stored rows with a built server), the currency,
the financial years, the active numbering series, whether Redis is on, and the environment switches `bootApp` set
(secret-named values masked, the database by name only). Pick the sources that change behaviour in your product.
A failing read shows as a `(not read)` section with the error, or a source's `(not read)` value, rather than failing
the file.

**Starting data** (`starting-data.ts`): from the setup entries' recorded rows (added rows only), a table per known
table with chosen columns, in business order (masters, places and people, stock, documents). Ids pointing at rows
the file made show their name (`productId` → the product's name). Configure `SHOWN` (table → label and columns),
`NAMED_BY` (column → table) and `NAME_OF` (table → name column) for your schema.

#### 6.4.10 Figures and checks (`test/support/watch.ts`, `test/support/checked.ts`)

Both optional, both cheap, both very useful to a reader.

- **`watch(...figures)`** in a spec or a describe registers figures for its scope (`beforeAll` adds, `afterAll`
  removes). A figure is `{ title, read(tools) }` returning named values (`{ debit: 448, closing: 448 }`) or
  `undefined` (not there yet). `tools` gives read-only SQL on the clone (`default_transaction_read_only=on`, the
  tenant schema on the search path, `application_name: 'e2e-trace'`) and `call(method, path, body)` to the app as the
  owner with the header `x-e2e-watch: 1` (left out of the test's calls). The hooks read all figures at every cut,
  after settling, and store before (the previous cut's reading) and after. A figure that throws shows its error.
  `readFigure(e2e, figure)` lets a test assert on the very reading the page shows; `changeOf(e2e, figures, work)`
  returns what `work` moved.
- **`checked(what, rows)`** returns `rows` and records "what, how many, the first 20 rows" on the running test. Use
  it in tests that read rows other tests wrote and make no call, so the page shows what was looked at.

#### 6.4.11 The dev pages (`src/dev/tests/`)

Inside the dev reports module (7.1), the e2e part is four small files plus the controller:

- `e2e-reports.ts`: `e2eReportsDir()` (env `E2E_REPORTS_DIR`, default `server/test/reports`), `listE2eRuns()`
  (folders named by a 14-digit stamp, newest first), `readRun(dir, stamp)` (from `results.json`: total, passed,
  failed, skipped = pending + todo, files, failing files, duration = last end − first start, failures with the first 6
  lines / 800 characters of the message; `finished: false` while there is no `results.json`; `traced` = number of
  `tests/*.json`), `e2eReportFile(stamp, file)` (path normalised and refused outside the run folder; content type by
  extension).
- `e2e-traces.ts`: the summary types, `testState()`, `traceSlug()`, `readTraces(runFolder)` (every `tests/*.json`,
  sorted; unreadable ones skipped).
- `e2e-areas.ts`: `E2E_AREAS`, the business areas in order, each with its topics in order (the order a company is
  set up and used: system, masters, purchase, sales, payments, stock, reports, settings, access, admin, decisions in
  the reference). `placeOf(source)` reads the spec's `Area: <area> / <topic>` line and refuses an unknown area or
  topic with the fix ("add it to the area's topics"). A unit test checks every spec has a valid line.
- `e2e-files.page.ts` / `e2e-traces.page.ts`: the file rows and the run page.

Routes (all `@Public()`, module imported only in development or with `TEST_REPORTS=true`):

| Route | Shows |
| --- | --- |
| `GET /api/dev/e2e` | per test set (by folder, for example company side and admin side): the **latest result of each spec file** across the kept runs (marked "from an earlier run" when not from the newest), then the kept runs, newest open: verdict, totals, failures, links to the run page and `results.json` |
| `GET /api/dev/e2e/runs` | the same runs as JSON |
| `GET /api/dev/e2e/runs/:stamp/tests` | one run: verdict, its failures (each linking to `<page>#t<index>`), then every spec file |
| `GET /api/dev/e2e/reports/:stamp/*file` | a file of the run folder; `tests/*.html` gets the one-open checkbox injected |

A file row shows: title (link to the page), the summary clamped to three lines with "more", the groups, "data &
decoys", the spec path and when it ran, a verdict badge ("N passed" or "N failed / M"; "N skipped or not built"),
time and number of calls. Rows are ordered: **files with a failing test first**, then by area and topic as
`E2E_AREAS` orders them (read from each spec's source when the page is shown, so retagging needs no rerun), by title
within a topic; files without a valid `Area:` line last under "Not placed". Each area header shows its files, tests,
failures and time. `GET /api/dev/tests` shows one card per set with the latest verdict.

#### 6.4.12 Masking, switches and rotation

- **Masking** (`mask.ts`): any key matching
  `/pass(word|code)?$|token|secret|^otp|otp$|authorization|cookie|api_?key|private_?key|^(m?pin|hash)$/i` has its
  non-empty value replaced by `***`, at any depth, in bodies, answers, changed rows and start settings; the same for
  query parameters in the path. Extend the pattern for your product's secret names; add a unit test.
- `E2E_TRACE=0`: no calls, rows or figures (6.4.3). `E2E_TRACE_QUIET_MS`: the settle quiet time (default 10).
- `E2E_KEEP_RUNS` (default 10): the global setup removes the oldest folders so that, with the new run, that many are
  kept. `E2E_REPORT_DIR`: set by the config for the workers. `E2E_REPORTS_DIR`: where the dev server reads (point it
  at the test checkout on a QA server).
- `E2E_TARGET=built`: specs against the built server behind the recording proxy (6.4.3).

#### 6.4.13 Optional: results proved through the product's own reports

Once the trace works, make tests read results the way a user does: through the product's reports, each report
checked against the database on the way.

- `test/support/reports/`: one **reader** per thing a test proves (an account's ledger, an item's stock, the trial
  balance, a document's due, any report by name). `reports(e2e)` returns them. A reader runs the report through the
  app as the frontend does (owner token, header `x-e2e-report: 1`), reads the same figure from the tables with
  read-only SQL, and calls **`agree(what, books, { reportA: …, reportB: … })`**: every key must equal the books'
  value, else it throws one line per key and report ("report X disagrees with the books"). The test then asserts on the
  reading. A test that reads through a report proves the report too, and the report's answer shows as a table on the
  page.
- **Repeat guard** (`repeat-guard.ts`): inside a test, asking the same report with the same body and caller twice
  with no write in between throws ("read it once and reuse the answer"). A `writeWatcher` middleware (in the app and
  the proxy) treats every non-GET call that is not a report call or sign-in as a write and clears the seen set. Hooks
  reset it per test; repeats inside an `it.fails` test fail the file at its end.
- **Sweep** (`REPORT_SWEEP=1`): before a file's app closes, every account with postings and every item with stock is
  read through the readers, and disagreements are written to `test/reports-sweep/<label>.json`. It finds report bugs
  over every spec's data without changing specs.

#### 6.4.14 Payload strictness warnings

The ops framework checks request bodies against their DTOs (`PAYLOADS_STRICT`: `error` refuses unknown fields,
`warn` drops and counts them, `off` drops them). With `warn`, `bootApp`'s `close` calls `savePayloadWarnings(label)`:
it reads `payloadWarnings()` from `@ops/framework` (endpoint, field, count), resets it, and writes
`<run>/payload-warnings/<label>.json` when there are any. That lists what the tests themselves send beyond the DTOs.
In process only (a built server keeps its own).

#### 6.4.15 What to copy, what to adapt

Copy as they are (rename the product prefix):

| File | Role |
| --- | --- |
| `test/support/trace/tracer.ts` | the per-file tracer: entries, cuts, recorder hooks |
| `test/support/trace/http-calls.ts` | the recorder middleware, caller line, body and answer capture |
| `test/support/trace/row-log.ts` | change log on the clone, `position` / `take` / `settle` |
| `test/support/trace/trace-hooks.ts` | the setup file: cuts per test, final states, page + JSON per file |
| `test/support/trace/trace-page.ts`, `test-state-html.ts`, `figures-html.ts`, `table-counts.ts` | the page |
| `test/support/trace/mask.ts`, `spec-doc.ts`, `start-settings-html.ts` | masking, header parsing, settings section |
| `test/support/watch.ts`, `test/support/checked.ts` | figures and checks |
| `test/support/payload-warnings.ts` | payload warnings per file |
| `src/dev/tests/e2e-reports.ts`, `e2e-traces.ts`, `e2e-files.page.ts`, `e2e-traces.page.ts`, `one-open.ts`, the e2e controller, and `src/dev/ago.ts` (relative times) + `src/dev/report-style.ts` (the pages' shared stylesheet) | dev pages |

The report helpers. In the reference they live under `scenarios/runner/` (paths below are relative to it); copy them
into `server/test/support/trace/` and fix the imports. Copy only the e2e report's parts: the reference versions still
carry code of the retired scenarios and parity tiers, which you leave out.

| Reference file | Role in the e2e report | Keep / leave out |
| --- | --- | --- |
| `row-changes.ts` | installs the change log (6.4.5), takes and folds it; `TableChange` / `RowChange` types | all |
| `table-keys.ts` | primary and foreign keys from the catalog, the watched-schemas SQL | all |
| `table-rows.ts` | `IGNORED` tables, each with its reason | all (edit the list) |
| `report/row-changes-html.ts` | the "Tables changed" HTML, its style and script; `esc`, `leaves` | leave out the parity flags and row anchors (`anchors.ts` import) |
| `report/values.ts` | `showValue`, `showDelta`, `pretty`, `summarize` for the figures table and bodies | leave out `changes()` (it reads story records) |
| `report/settings-html.ts` | `SETTINGS_STYLE` for the start-settings section | leave out `settingsHtml` / `StorySettings` |
| `story.ts` | the figure reading type `Reading` (named values) used by `watch.ts` and the tracer | only `Reading` (a small `figure-types.ts`); drop the story, step, record and observer types |
| `db.ts` | the `Sql` interface (`rows`, `one`, `close`) the change log and figures read through | only the interface; the trace opens its own connections |

In the reference's `watch.ts`, leave out `fromObserver` (it adapts the retired scenarios' observers) and with it the
imports of `routing.ts` and the `Observer` / `ObserveTools` types; figures are written with `figure(title, read)` and
call the app with `tools.call(method, path, body)` on your own paths. The reference's figure readers (`test/support/figures.ts`, built on
`scenarios/runner/observe/*`) are product-specific: write your own small readers in `test/support/figures.ts`.

Adapt to your product:

- **Names:** the clone prefix and template name (`<product>_e2e_…`), the tenant schema name the trace and readers
  query (an env such as `E2E_SCHEMA`), the base schema to unwatch (if any).
- **The partition column** (for example `companyId`): left out of start settings, used to key multi-company rows, and
  named in every reader's SQL.
- **The caller line:** which claims your tokens carry.
- **Ignored tables** in the change log (migrations, sessions, OTPs, login logs, internal audit logs), each with its
  reason.
- **Start settings sources** and **starting data tables** (`SHOWN`, `NAMED_BY`, `NAME_OF`).
- **Report shapes** in `report-table-html.ts` and the **report names** the readers run.
- **Areas and topics** in `e2e-areas.ts`, and the test sets (by folder) on `/api/dev/e2e`.
- **Secret key pattern** in `mask.ts`.

Check it works: run one spec, open its page from `/api/dev/e2e`, and confirm a create call shows its inserted row
under "Tables changed", a refused call (422) shows no rows, an after-commit write (a mail log, a recalculation) shows
under the call that caused it, and a password in a body shows as `***`.

---

## 7. Reports pages, QA runs, settings coverage

### 7.1 The dev reports module (backend, `src/dev/tests/`)

One Nest module (module, controller, service and page builders). It is imported **only** when
`NODE_ENV === 'development'` or `TEST_REPORTS=true`. The routes are `@Public()`; there is nothing secret on them, but
never enable them in production.

- `GET /api/dev/tests`: one card per test set (for example the e2e company side and admin side, and any extra set),
  each with the latest verdict, the time of the newest run and the command that runs it.
- `GET /api/dev/e2e`: each spec file's latest result by business area, then the kept e2e runs, newest first and
  opened: totals, the failing tests with their first message lines, links to the run's report page and
  `results.json`. Serve the files by `stamp` (14 digits) and refuse any path outside that folder (`normalize` +
  `startsWith(folder + sep)`). The full e2e part is in section 6.4.11.
- Plain server-rendered HTML with a small inline stylesheet (light and dark), no frontend build. Show relative times
  ("3 min ago") through a tiny inline script.

### 7.2 Running the tests on the QA server

Run every tier on the QA server, after each deploy or on a nightly schedule: unit tests of both apps, then the backend
e2e, then the UI auto-tester headless. A tier's failures never stop the run; the next tier runs anyway.

- The deploy (or schedule) job starts the run script (for example `deploy/qa-tests.sh`) **detached, in its own
  process group**, writes its pgid to a file, and finishes.
- A newer start first **kills the previous run's process group** (`kill -- -<pgid>`), then starts a new run. The
  workflow has `concurrency: { group: qa-tests, cancel-in-progress: true }`. Old e2e reports go by `E2E_KEEP_RUNS`
  (6.4.12), not by hand.
- The run builds the template **from scratch** (no cache on servers) from that commit's migrations, on a Docker stack
  on the QA box (its own ports, tmpfs). If another run holds the stack (a lock file), it waits or skips with a reason.
- The e2e reports dir comes from `E2E_REPORTS_DIR`, outside the deployed folder, so a deploy does not wipe a run in
  progress. The QA backend serves `/api/dev/e2e` from it, with `TEST_REPORTS=true` in the QA env secret. The UI
  tier's Playwright report stays in the auto-tester's checkout.
- The run writes a status file (`running: building template`, `running: backend e2e`, `finished: e2e 1066 of 1077
  passed, 9 failed; UI 38 of 39 specs passed`, `failed: template did not build`). The `/api/dev/tests` page shows it
  at the top; the e2e pages list files as they finish.
- Give each tier a time limit, and always stop the apps and the browser at the end (`npm run e2e:down`).

### 7.3 Settings coverage map (`scripts/settings-impact.ts` → `docs/settings-impact.md`)

A script scans the backend and frontend for every read of a company or tenant setting key (grep the settings
accessor; parse with the TS compiler API if needed). It lists each key with the files that read it and the
tests (unit, e2e, UI) that set it to a non-default value. Keys never tested off their default are listed first.

Commit the generated file. A CI step (`npm run settings:check`) fails when a new key appears without a test, against
a committed baseline of known gaps. The baseline only shrinks.

---

## 8. Tier 4: the UI auto-tester (Playwright + desk automation)

### 8.1 How the UI is driven

The desk framework has an **automation driver** (`src/desk/framework/automation/`). When automation is on, it installs
`window.__desk`, which can:

- describe the screen as a tree of nodes (forms, fields, grids, rows, actions, dialogs), with their state and issues;
- act on it (`act`, `fill`, `answer`, `navigate`, `press`).

The **testkit** (`src/desk/framework/testkit/`, Node side, no runtime imports from the app) wraps it for Playwright:
`createDeskClient(page)`, `createDeskUser(client)`, grid helpers (`deskFindRow`, `deskRunRowAction`, `deskEditCell`,
`deskExpectNoRow`), settings helpers (`deskSettingsRows`, `deskFormDiff`), `deskFixtureDefs()` for `test.extend`,
`runDeskConformance` and `deskMcpTools`. Read `testkit/README.md` in your copy of the desk framework.

Two styles of helper:

- **As a person** (the plain names): find the element by the desk's `data-desk-*` attributes and click or type. Every
  screen gets at least one spec in this style.
- **Direct** (`…Direct`, `client.act/fill/answer`): the same through the driver, fast. Use it for steps a person-style
  spec already covered, so later specs do not pay for typing again.

Product-specific helpers (open a company, make a voucher, SQL checks) live in the auto-tester's `src/`, built on the
testkit. Anything generic goes back into the testkit.

### 8.2 Layout

```
<product>-auto-tester/
  playwright.config.ts   workers: 1, fullyParallel: false, retries: 0, projects ux / data / api, html reporter
  scripts/e2e/cli.ts     orchestrator: stack up → clone template → start backend → start frontend → wait → playwright → stop
  src/
    env.ts               ports, paths to ../server and ../frontend (env-overridable), headed / slowMo
    fixtures.ts          test.extend(deskFixtureDefs()) + product fixtures (open company, desk client, user)
    global-setup.ts      signs in through the real login page once, saves storageState
    db.ts                read-only SQL checks on the run database
    sets.ts              apply a settings set (JSON in sets/) through the real settings screen or endpoint
  specs/
    ux/NNNN_<screen>.spec.ts     screens, as a person
    data/NNNN_<area>.spec.ts     settings sets: apply, reopen, diff to nothing (round trip)
    api/NNNN_<check>.spec.ts     no browser: integrity SQL (every document balances, no orphans)
  sets/                  JSON settings sets (base, feature-on combinations)
  calc/                  calculation agreement tests (Vitest, no stack)
  README.md
```

### 8.3 The orchestrator (`scripts/e2e/cli.ts`)

- **Modes:**
  - `dev`: `nest start` / `quasar dev`;
  - `built`: `nest build` + `node dist/main`; `quasar build` + a small static server;
  - `prod`: the backend's real Dockerfile, the frontend's nginx image, with CPU and memory limits.
- **Before starting the backend,** check its env: the database, Redis and any outbound service must point at the test
  stack or be off. Override them for that process only. **Refuse to run** if the database is not the local test port.
  Never edit the developer's `.env` files.
- Wait for `GET /` (backend) and the frontend's index to answer before Playwright starts.
- **Snapshots:** after each passing spec file, `CREATE DATABASE snap_N TEMPLATE run_db` (keep the last 3).
  `test:e2e:resume` restores the one before the failed file, clears Redis, restarts the backend and continues. It
  refuses when the migrations fingerprint changed.
- **Commands:**
  - `test:e2e` (full);
  - `test:e2e -- --headed`;
  - `test:e2e:only` (against what is already up);
  - `test:e2e:again` (fresh clone, backend restart, specs);
  - `test:e2e:resume`;
  - `test:e2e -- --only specs/ux/0010_x.spec.ts`;
  - `e2e:down`, `stack:down`.
- Logs go to `.e2e-run/backend.log` and `.e2e-run/frontend.log`, replaced on each start.

### 8.4 Playwright settings that matter

```ts
export default defineConfig({
  testMatch: /specs\/.*\.spec\.ts/,
  fullyParallel: false, workers: 1, retries: 0,       // one database, one session: no parallel runs
  timeout: 45_000, expect: { timeout: 5_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './src/global-setup.ts',
  use: {
    baseURL: env.frontendUrl, storageState: env.authFile, headless: !env.headed,
    actionTimeout: 5_000, navigationTimeout: 15_000,   // a missing element fails in seconds
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
  projects: [
    { name: 'ux', testMatch: /specs\/ux\// },
    { name: 'data', testMatch: /specs\/data\// },
    { name: 'api', testMatch: /specs\/api\//, use: { storageState: undefined } },
  ],
});
```

- **Headed for people** (`--headed`, a little `slowMo`), so a developer can watch. Headless in CI.
- Spec files are numbered (`0000_login`, `0010_…`), so the order is stable and resume works.
- Wait on state, never on time: poll the driver (`until(() => dialogOpen(desk, 'x'))`) instead of `waitForTimeout`.

### 8.5 What the UI tier covers

- **Login and session:** sign in, switch company or branch, expiry, licence or plan dialogs.
- **Route audit:** every route in the desk's route catalog opens without errors, and `runDeskConformance` passes (every
  node drivable, labels, keyboard reachable).
- **Menu and keyboard:** every shortcut the desk promises works.
- **Each master screen:**
  - create as a person;
  - the refusal shows under the field;
  - edit;
  - delete, and the row is gone (`deskExpectNoRow`);
  - the row actions are offered or withheld per state and role (`deskRowActionStates`).
- **Each document screen:** fill lines in the editable grid (`deskEditCell`); totals on screen equal the saved
  document; reopen and `deskFormDiff` is empty (round trip).
- **Settings sets:** for each `sets/*.json`, apply it, reopen the settings screen, diff to nothing. Then run the
  screens it affects.
- **Integrity (api project):** SQL invariants after the run (every document balances, no orphan lines, stock never
  negative where not allowed).

### 8.6 Agent access (optional)

`npm run mcp` starts an MCP server that exposes `deskMcpTools(client)` against a running browser, so an AI agent can
drive the app through the same driver the tests use, to explore a bug or draft a spec.

---

## 9. Setting up the frameworks in a new product

1. **ops framework:**
   - `git clone <ops-framework repo> ~/Development/ops-framework`, then follow its README to build it and link or
     install it (`npm run pack:local`, then install the tarball in `server/`, or a `file:` dependency).
   - Its peer dependencies (Nest, sequelize, sequelize-typescript, pg, nestjs-cls, class-validator, ioredis) must be
     single instances in `server/`.
   - Read `ops-framework/docs/ops.md` before writing steps or tests.
2. **desk framework:**
   - Copy `src/desk/framework/` from the reference project into `frontend/src/desk/framework/`, including
     `automation/` and `testkit/`.
   - Product screens go in `frontend/src/desk/<product>/`. Do not edit the framework copy for product needs. Improve
     it generically and note the change, so it can go back upstream.
   - The auto-tester imports the testkit through a path alias (`@desk/testkit` →
     `../frontend/src/desk/framework/testkit`).
3. **Automation switch:** the driver installs only when the app is built or served with the test flag (for example
   `E2E_API_URL` set). A production bundle leaves it out. Write a test that checks a production build has no
   `window.__desk`.

---

## 10. Build order for the agent (each step ends with its check passing)

| # | Build | Done when |
| --- | --- | --- |
| 1 | `.gitignore` entries; Vitest in both apps; one trivial spec each | `npm test` passes in `server/` and `frontend/` |
| 2 | Backend unit specs for existing op steps, flows and calculations | every op folder has specs; `npm test` green |
| 3 | Frontend: logic moved out of components; unit specs; API-layer specs; calculation agreement (5.1) if the desk calculates | `npm test` green; no business calculation left untested inside a `.vue` file |
| 4 | Docker stack + `stack.ts` (`up`, `down`, `template`, `save`, `--rebuild`), test-only register endpoint, local dump cache | `npm run db:template` builds from scratch the first time, then restores in seconds; production 404s the test endpoints |
| 5 | e2e support (`cloneTemplate`, `bootApp`, `signIn`, users per role), global setup, JSON reporter | one e2e spec per module covering section 6.3; `npm run test:e2e` green; `test/reports/<stamp>/results.json` written |
| 6 | The e2e report (section 6.4): the report helpers in `test/support/trace/` (6.4.15), trigger change log + key reading + folding (6.4.5), recorder middleware, `RowLog` with settle, tracer attached in `bootApp`, setup-file hooks, per-file page and JSON, spec headers with `Area:`, start settings, starting data, masking, `E2E_TRACE=0`; then figures, `checked`, payload warnings; the reports readers with `agree` if you want them | `test/reports/<stamp>/tests/` has a page and a JSON per spec file; a create call shows its inserted rows, a 422 shows none, an after-commit write shows under its call, secrets show as `***`; with `E2E_TRACE=0` the pages still list every test's state |
| 7 | Dev reports module (`/api/dev/tests`, `/api/dev/e2e` as in 6.4.11 and 7.1) | pages show the latest runs; e2e files grouped by area, failing first, each opening its page; off in production |
| 8 | Auto-tester: orchestrator, fixtures, global login, first `ux` specs, `api` integrity specs | `npm run test:e2e -- --headed` runs login + one master + one document |
| 9 | Settings sets (`data` project), route audit, conformance, snapshots/resume | resume continues after a deliberate failure |
| 10 | Settings impact map + CI gate (7.3) | the generated doc lists every key; CI fails on a new untested key |
| 11 | QA test run (7.2: detached, kill previous, template from scratch, unit + e2e + UI, status file) | two quick starts leave one run, the newer one; `/api/dev/e2e` on QA lists its files as they finish |
| 12 | READMEs per tier (run all, run one, write one, where reports are) | a new developer can add a test from the README alone |

---

## 11. Prompt to give the AI agent

> You are adding the automated test system described in `TEST-SYSTEM-PLAYBOOK.md` to this product (Quasar + desk
> framework frontend in `frontend/`, NestJS + `@ops/framework` backend in `server/`). Read the whole playbook, then
> `server/node_modules/@ops/framework/docs/ops.md` (or the cloned `ops-framework/docs/ops.md`) and
> `frontend/src/desk/framework/testkit/README.md`.
>
> The system is e2e only: unit tests, backend e2e with its report, and the UI auto-tester. Do not build a scenarios
> ("stories") tier or any parity check, even where the reference repo still has one; copy only the report helpers
> section 6.4.15 lists, into `server/test/support/trace/`.
>
> Follow section 1's rules at all times. Work through section 10 in order, one step at a time. At the end of each step,
> run that step's check and show me the output. Do not start the next step until it passes. Make test data only
> through the product's endpoints. Never point a test at a non-local database. Never commit reports, dumps or caches.
> Keep files small and modular, and put generic helpers into the frameworks' testing parts.
>
> The e2e report is part of the job, not an extra: build it exactly as section 6.4 describes (the trace's recorder,
> the trigger change log on each clone, the setup-file hooks, one HTML page and one JSON summary per spec file, and the
> `/api/dev/e2e` pages), and start every spec with the header comment and `Area:` line of 6.4.9.
>
> When a test fails because the product is wrong, not the test, stop and tell me: the endpoint, the input, what
> happened, and what you expected. Do not change product behaviour to make a test pass without asking. Keep open
> questions in `docs/testing-decisions.md` and carry on with the next item meanwhile.

---

## 12. Final checklist

- [ ] `npm test` green in both apps, no Docker needed.
- [ ] `npm run stack:up && npm run db:template`: first build from scratch, later restored from the local dump in
      seconds; `--rebuild` after new migrations.
- [ ] `npm run test:e2e` (server): one clone per file, leftover clones dropped, `results.json` plus a page and a JSON
      summary per spec file with every call and the rows each call changed, after-commit work settled into its call
      (section 6.4).
- [ ] `/api/dev/tests` and `/api/dev/e2e` work on a dev server and are absent in production.
- [ ] Auto-tester: `npm run test:e2e -- --headed` drives real screens; resume works; integrity checks pass.
- [ ] Settings impact map generated and gated in CI.
- [ ] QA runs unit, e2e and UI tests with a template built from scratch, kills an older run, shows progress.
- [ ] No scenarios folder, parity code or scenarios page in the product.
- [ ] No secrets, dumps, reports or caches in git; every tier has a README.
