# @ops/framework

The operations framework behind TMS and the Ankpal ERP rebuild: multi-tenant NestJS +
sequelize-typescript, where every create, update, delete, list and action runs as numbered step
files (code or data), with tenancy, ACL with scopes and limits, row guards and audit built in.

- Usage guide: [`docs/ops.md`](docs/ops.md) (keep it current with every framework change).
- Build: `npm run build` (ESM + `.d.ts` in `dist/`). Tests: `npm test`.
- Projects install a copy: `.npmrc` `install-links=true`, `"@ops/framework": "file:../../ops-framework"`,
  then `npm run fw:update` in the project after changing the framework.
- Entries: `@ops/framework` (everything apps use), `@ops/framework/names` (naming, loads no model),
  `@ops/framework/testing` (`fakeOpContext`, `runSteps`), `@ops/framework/internal` (infrastructure tests).
- The framework knows nothing about a project: names (`defineNames`), features (`features` of
  `FrameworkModule.forRootAsync`) and options decide its tables, routing, ACL and audit.
