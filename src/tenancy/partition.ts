/**
 * The tenant partition: which column marks a row as belonging to one tenant (company) inside a
 * database. Always on, also in a dedicated schema or database that holds a single company, so a
 * company can move between placements without its rows changing.
 *
 * Model classes read this when they are declared, so an app that wants other names calls
 * `defineNames({ partition })` from `@ops/framework/names` before it imports any model.
 * Defaults: attribute and column `companyId`, mirror table `Companies` (sequelize defaults).
 */
export interface PartitionConfig {
  /** Attribute name on models and on `AuthUser`. */
  field: string;
  /** Column name in the project's tables. */
  column: string;
  /** Table of the per-schema tenant mirror the partition column references. */
  mirror: string;
  /**
   * Models (by model name) that carry the partition attribute but are shared across tenants, so
   * the framework neither fills nor pins it (lookup tables such as states or currencies).
   */
  exempt: string[];
}

export const PARTITION: PartitionConfig = { field: 'companyId', column: 'companyId', mirror: 'Companies', exempt: [] };

export function definePartition(config: Partial<PartitionConfig>): void {
  Object.assign(PARTITION, config);
}

/** The partition value of a user, a row or any object that carries the partition field. */
export function partitionValue(source: object): number {
  return (source as Record<string, number>)[PARTITION.field] as number;
}

/** Column of the partition in the framework's own (always snake_case) tables. */
export function frameworkPartitionColumn(): string {
  return PARTITION.field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Column of the partition in one model's table (its attribute's `field`). */
export function partitionColumnOf(model: { getAttributes(): Record<string, { field?: string }> }): string {
  return model.getAttributes()[PARTITION.field]?.field ?? PARTITION.column;
}
