import type { ModelStatic } from 'sequelize';
import type { Model } from 'sequelize-typescript';
import { polymorphicOf, REFERENCE_TABLES } from '../../db/refs.js';
import { PARTITION } from '../partition.js';
import { orderByDependencies, refEdges } from '../ref-graph.js';

type AnyModel = ModelStatic<Model> & { tableName: string };

/** A column whose id changes with the move, and how to translate it. */
export interface Remap {
  column: string;
  /** Table whose id map applies (absent for polymorphic columns, which pick by `polymorphic.typeColumn`). */
  table?: string;
  /** `0` stays `0` ("the system"). */
  zeroIsSystem: boolean;
  polymorphic?: { typeColumn: string; types: Record<string, string> };
}

export interface TablePlan {
  model: AnyModel;
  table: string;
  /** `mirror`: the one company row; `reference`: same rows everywhere, matched by `naturalKey`; `partitioned`: copied with new ids. */
  kind: 'mirror' | 'reference' | 'partitioned';
  naturalKey?: string;
  /** Real foreign keys to tables copied earlier: translated while inserting. */
  inline: Remap[];
  /** Everything else (self references, soft references, polymorphic ids): translated in a pass after all rows exist. */
  later: Remap[];
  /** Self references with a foreign key: inserted as null, set right after the table's rows exist. */
  selfColumns: string[];
  /** Join tables have no `id`: nothing points at their rows, so they get no id map. */
  hasId: boolean;
  /** The columns the model declares: exactly these are copied, whatever else the source table has. */
  columns: string[];
}

/** Stored columns of a model (virtual attributes have no column). */
export function columnsOf(model: AnyModel): string[] {
  return Object.entries(model.getAttributes())
    .filter(([, definition]) => String((definition as { type?: { key?: string } }).type?.key) !== 'VIRTUAL')
    .map(([attribute, definition]) => (definition as { field?: string }).field ?? attribute);
}

const columnOf = (model: AnyModel, attribute: string): string => (model.getAttributes()[attribute] as { field?: string } | undefined)?.field ?? attribute;

/**
 * What the move tool does for each table, from the model declarations alone: hard references are
 * translated on insert (tables are copied in foreign-key order), soft and polymorphic references
 * afterwards. A tenant table that is neither partitioned, the mirror nor a reference table is an
 * error: the tool would not know how to move it.
 */
export function buildCopyPlan(models: AnyModel[]): TablePlan[] {
  const ordered = orderByDependencies(models);
  const edges = refEdges(models);
  // Polymorphic ids can only point at tables whose ids are remapped: the partitioned ones.
  const movable = (model: AnyModel) =>
    model.tableName !== PARTITION.mirror && !REFERENCE_TABLES.has(model.tableName) && PARTITION.field in model.getAttributes() && 'id' in model.getAttributes();
  const tableOfModel = new Map(models.filter(movable).map((model) => [model.name, model.tableName]));
  return ordered.map((model): TablePlan => {
    const table = model.tableName;
    const attributes = model.getAttributes();
    if (table === PARTITION.mirror) return { model, table, kind: 'mirror', inline: [], later: [], selfColumns: [], hasId: true, columns: columnsOf(model) };
    const natural = REFERENCE_TABLES.get(table);
    if (natural) return { model, table, kind: 'reference', naturalKey: columnOf(model, natural), inline: [], later: [], selfColumns: [], hasId: true, columns: columnsOf(model) };
    if (!(PARTITION.field in attributes)) {
      throw new Error(`Table "${table}" cannot be moved: declare it partitioned (tenantTable), a reference table or the partition mirror.`);
    }
    const inline: Remap[] = [];
    const later: Remap[] = [];
    const selfColumns: string[] = [];
    for (const edge of edges.filter((e) => e.model === model && e.table !== PARTITION.mirror)) {
      const remap: Remap = { column: edge.column, table: edge.table, zeroIsSystem: edge.zeroIsSystem };
      // A self reference with a real foreign key is inserted as null and filled once the parent exists.
      // A soft one has no constraint and is translated with the others.
      if (edge.table === table && edge.hard) selfColumns.push(edge.column);
      else if (edge.hard) inline.push(remap);
      else later.push(remap);
    }
    for (const pair of polymorphicOf(model)) {
      const types = pair.types ?? Object.fromEntries(tableOfModel);
      later.push({ column: columnOf(model, pair.idColumn), zeroIsSystem: false, polymorphic: { typeColumn: columnOf(model, pair.typeColumn), types } });
    }
    return { model, table, kind: 'partitioned', inline, later, selfColumns, hasId: 'id' in attributes, columns: columnsOf(model) };
  });
}
