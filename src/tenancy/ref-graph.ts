import type { ModelStatic } from 'sequelize';
import type { Model } from 'sequelize-typescript';
import { notRefsOf, polymorphicOf, softRefsOf } from '../db/refs.js';
import { PARTITION } from './partition.js';

type AnyModel = ModelStatic<Model> & { tableName: string };

/** One column that holds the id of another table. */
export interface RefEdge {
  model: AnyModel;
  /** Attribute name. */
  attribute: string;
  /** Column name. */
  column: string;
  /** Referenced table. */
  table: string;
  /** Declared with a database constraint (real foreign key) or only registered (`@SoftRef`). */
  hard: boolean;
  zeroIsSystem: boolean;
  nullable: boolean;
}

function tableOf(reference: unknown): string | null {
  if (!reference) return null;
  if (typeof reference === 'string') return reference;
  const object = reference as { tableName?: string; table?: string };
  return object.tableName ?? object.table ?? null;
}

/** Every id column of `models`, hard or soft, except the partition column. Uses the declared metadata only. */
export function refEdges(models: AnyModel[]): RefEdge[] {
  const edges: RefEdge[] = [];
  for (const model of models) {
    const soft = softRefsOf(model);
    for (const [attribute, definition] of Object.entries(model.getAttributes())) {
      if (attribute === PARTITION.field) continue;
      const table = tableOf((definition as { references?: unknown }).references && ((definition as { references: { model?: unknown } }).references.model));
      const softDef = soft?.get(attribute);
      const column = (definition as { field?: string }).field ?? attribute;
      const nullable = (definition as { allowNull?: boolean }).allowNull !== false;
      if (table) edges.push({ model, attribute, column, table, hard: true, zeroIsSystem: false, nullable });
      else if (softDef) edges.push({ model, attribute, column, table: softDef.table, hard: false, zeroIsSystem: softDef.zeroIsSystem, nullable });
    }
  }
  return edges;
}

/** `...Id` integer columns with no declared reference: the boot check fails on these. */
export function undeclaredIdColumns(models: AnyModel[]): string[] {
  const declared = new Set(refEdges(models).map((edge) => `${edge.model.name}.${edge.attribute}`));
  const problems: string[] = [];
  for (const model of models) {
    const notRef = notRefsOf(model);
    const polymorphic = new Set(polymorphicOf(model).map((pair) => pair.idColumn));
    for (const [attribute, definition] of Object.entries(model.getAttributes())) {
      const type = String((definition as { type?: { key?: string } }).type?.key ?? '');
      if (!attribute.endsWith('Id') || attribute === PARTITION.field || attribute === 'id' || !/INTEGER|BIGINT/.test(type)) continue;
      if ((definition as { primaryKey?: boolean }).primaryKey) continue;
      if (declared.has(`${model.name}.${attribute}`) || notRef.has(attribute) || polymorphic.has(attribute)) continue;
      problems.push(`${model.name}.${attribute}`);
    }
  }
  return problems;
}

/**
 * Models in the order their tables can be created or copied: a table comes after every table it
 * references by a real foreign key (soft references are filled in afterwards by the move tool). Self references are ignored; references to tables outside `models` (the partition
 * mirror in another group) are ignored too.
 */
export function orderByDependencies<T extends AnyModel>(models: T[]): T[] {
  const byTable = new Map(models.map((model) => [model.tableName, model]));
  const deps = new Map<T, Set<T>>();
  for (const edge of refEdges(models)) {
    // Soft references have no constraint, so they never decide creation order (audit columns point at users, who point at roles).
    if (!edge.hard) continue;
    const target = byTable.get(edge.table);
    if (!target || target === (edge.model as AnyModel)) continue;
    const set = deps.get(edge.model as T) ?? new Set<T>();
    set.add(target);
    deps.set(edge.model as T, set);
  }
  // The partition column references the mirror table: that table goes first.
  const mirror = byTable.get(PARTITION.mirror);
  const out: T[] = [];
  const state = new Map<T, 'visiting' | 'done'>();
  const visit = (model: T, path: string[]) => {
    if (state.get(model) === 'done') return;
    if (state.get(model) === 'visiting') throw new Error(`Cyclic table dependency: ${[...path, model.name].join(' -> ')}`);
    state.set(model, 'visiting');
    if (mirror && model !== mirror && PARTITION.field in model.getAttributes()) visit(mirror, [...path, model.name]);
    for (const dep of deps.get(model) ?? []) visit(dep, [...path, model.name]);
    state.set(model, 'done');
    out.push(model);
  };
  for (const model of models) visit(model, []);
  return out;
}
