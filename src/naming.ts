import { definePartition, type PartitionConfig } from './tenancy/partition.js';

/**
 * Names and conventions the framework uses for the project's tables. Defaults follow the Ankpal
 * style (camelCase columns, `Model` defaults); TMS-style projects pass `underscored: true` and their
 * partition column. The framework's own tables (roles, entity_events, document_sequences, routing...)
 * are always snake_case; these names only shape the project's models and the SQL that touches them.
 */
export interface FrameworkNames {
  /** Schema of the control plane (identities, companies, routing). */
  controlSchema: string;
  /** Tenant table of users: audit columns and per-user permission overrides point at it. */
  userTable: string;
  /** `tenantTable()` / `controlTable()` / `referenceTable()` define snake_case columns. Default false (camelCase). */
  underscored: boolean;
}

export const NAMES: FrameworkNames = { controlSchema: 'platform', userTable: 'users', underscored: false };

/**
 * Renames the framework's tables and columns. Model classes read these when they are declared, so
 * call it before any model is imported: import it from `@ops/framework/names` (which loads no
 * model) in a side-effect module that is the first import of `main.ts`, tools and test setup.
 */
export function defineNames(config: Partial<FrameworkNames> & { partition?: Partial<PartitionConfig> }): void {
  const { partition, ...names } = config;
  if (partition) definePartition(partition);
  Object.assign(NAMES, names);
}
