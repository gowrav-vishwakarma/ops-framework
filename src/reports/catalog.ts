import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import type { Model, ModelStatic } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { PARTITION } from '../tenancy/partition.js';
import type { ReportCatalogOptions, ReportRowScopeOptions, ReportsConfig } from './options.js';
import { REPORTS_CONFIG } from './tokens.js';

export type CatalogFieldType = 'number' | 'text' | 'date' | 'datetime' | 'boolean' | 'json' | 'enum';

export interface CatalogField {
  name: string;
  label: string;
  type: CatalogFieldType;
  /** Database column, when it differs from the attribute name. */
  column: string;
  values?: string[];
  primaryKey?: boolean;
}

export interface CatalogRelation {
  /** Association name (`as`): `party`, `items`. */
  name: string;
  label: string;
  /** `one`: belongs-to or has-one, safe to read in a row. `many`: has-many, aggregate it. */
  type: 'one' | 'many';
  target: string;
  /** Join: this model's `sourceKey` = target's `targetKey`. Attribute names. */
  sourceKey: string;
  targetKey: string;
  /**
   * The association's own condition on the target (Sequelize `scope`): an account's `billingAddress` is the address
   * with `kind` 'billing'. A join reads only those rows (`null`: the field is empty).
   */
  where?: Array<{ field: string; value: string | number | boolean | null }>;
}

/** How every read of a model is narrowed. Columns are database columns. */
export interface CatalogScope {
  /** The partition (company) column; null for a model without it. */
  company: string | null;
  /** Shared by every company (the partition's `exempt` list): read with no company condition. Else a model without
   * the column is refused, so a model a project forgot to partition never reads other companies' rows. */
  companyShared?: boolean;
  /** Row scope (`reports.rowScope`): `own` has the scope field, `path` reaches it through `rowPath`, `none` is not scoped. */
  row: 'own' | 'path' | 'none';
  /** `own`: the scope field's column (the first of `rowColumns`). */
  rowColumn?: string;
  /** `own`: every scope column; any of them is enough (`rowScope.fields`). */
  rowColumns?: string[];
  /** Not scoped on purpose: a master every scope shares (`rowScope.free`). */
  rowShared?: boolean;
  rowPath?: string;
  /** Soft delete: a flag column true when deleted (`reports.catalog.softDeleteFlags`), or a paranoid timestamp. */
  softDelete: { column: string; kind: 'flag' | 'timestamp' } | null;
}

export interface CatalogModel {
  name: string;
  label: string;
  /** Table name (the schema is the request's tenant). Server only; not sent to the browser. */
  table: string;
  fields: CatalogField[];
  relations: CatalogRelation[];
  scope: CatalogScope;
}

export interface ModelCatalog {
  version: string;
  models: Record<string, CatalogModel>;
  /** `rowScope.unscoped`: a scoped user's read of an unscoped model is refused (`refuse`) or reads it whole. */
  unscoped?: 'read' | 'refuse';
  /** What the row scope is called in refusals (`rowScope.label`, or from its field). */
  rowLabel?: { one: string; many: string };
}

/** The catalog as the browser gets it: no table or scope column names. */
export interface PublicCatalogModel extends Omit<CatalogModel, 'table' | 'scope'> {
  scope: { company: boolean; row: CatalogScope['row']; rowPath?: string; softDelete: boolean };
}

/** Fields that never reach a report, whatever the model. A project adds its own (`hiddenFields`). */
const SECRET_FIELDS: RegExp[] = [/password/i, /secret/i, /token/i, /otp/i, /apiKey/i, /hash$/i, /salt$/i, /privateKey/i];
const ACRONYMS = ['id', 'sku', 'uom'];

function fieldType(type: unknown): CatalogFieldType {
  const key = String((type as { key?: string } | undefined)?.key ?? '').toUpperCase();
  if (['INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'FLOAT', 'DOUBLE', 'REAL', 'NUMBER'].includes(key)) return 'number';
  if (key === 'DATEONLY') return 'date';
  if (key === 'DATE' || key === 'NOW' || key === 'TIME') return 'datetime';
  if (key === 'BOOLEAN') return 'boolean';
  if (key === 'JSON' || key === 'JSONB' || key === 'ARRAY') return 'json';
  if (key === 'ENUM') return 'enum';
  return 'text';
}

/** `invoiceDate` / `invoice_date` → `Invoice date`; `acronyms` are written in capitals (`GST`, `HSN`). */
export function humanize(name: string, acronyms: readonly string[] = ACRONYMS): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
  const words = new RegExp(`\\b(${acronyms.map((word) => word.toLowerCase()).join('|')})\\b`, 'g');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase().replace(words, (m) => m.toUpperCase());
}

type Attributes = Record<string, { type: unknown; field?: string; values?: string[]; primaryKey?: boolean }>;

/**
 * Every model a report may read, with fields, relations and how each read is scoped. Built once per process from
 * Sequelize's own model metadata, so it follows the models; `reports.catalog` adds what metadata cannot say.
 */
@Injectable()
export class ReportCatalogService {
  private cached: ModelCatalog | null = null;
  private readonly notes: ReportCatalogOptions;
  private readonly rows: ReportRowScopeOptions | undefined;

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    @Inject(REPORTS_CONFIG) config: ReportsConfig,
  ) {
    this.notes = config.catalog ?? {};
    this.rows = config.rowScope;
  }

  catalog(): ModelCatalog {
    if (!this.cached) this.cached = buildReportCatalog(this.sequelize.models as Record<string, ModelStatic<Model>>, this.notes, this.rows);
    return this.cached;
  }

  model(name: string): CatalogModel | undefined {
    return this.catalog().models[name];
  }

  /** The catalog as the browser gets it. */
  publicCatalog(): { version: string; models: PublicCatalogModel[] } {
    const { version, models } = this.catalog();
    return {
      version,
      models: Object.values(models)
        .map(({ table: _table, scope, ...rest }): PublicCatalogModel => ({
          ...rest,
          scope: { company: scope.company !== null, row: scope.row, ...(scope.rowPath ? { rowPath: scope.rowPath } : {}), softDelete: scope.softDelete !== null },
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    };
  }
}

/** The catalog of these models (a Sequelize connection's `models`). Exported for tests that hold no Nest app. */
export function buildReportCatalog(statics: Record<string, ModelStatic<Model>>, notes: ReportCatalogOptions = {}, rows?: ReportRowScopeOptions): ModelCatalog {
  const acronyms = [...ACRONYMS, ...(notes.acronyms ?? [])];
  const label = (name: string) => humanize(name, acronyms);
  const hiddenModel = (name: string) =>
    (notes.include ? !notes.include(name) : false) || (notes.hiddenModels ?? []).some((rule) => (typeof rule === 'string' ? rule === name : rule.test(name)));
  const hiddenField = (name: string) => [...SECRET_FIELDS, ...(notes.hiddenFields ?? [])].some((pattern) => pattern.test(name));
  const free = new Set(rows?.free ?? []);
  const models: Record<string, CatalogModel> = {};

  for (const [name, model] of Object.entries(statics)) {
    if (hiddenModel(name)) continue;
    const attributes = model.getAttributes() as Attributes;
    const fields: CatalogField[] = [];
    for (const [attr, def] of Object.entries(attributes)) {
      if (hiddenField(attr)) continue;
      const type = fieldType(def.type);
      const field: CatalogField = { name: attr, label: label(attr), type, column: def.field ?? attr };
      if (type === 'enum' && Array.isArray(def.values)) field.values = [...def.values];
      if (def.primaryKey) field.primaryKey = true;
      fields.push(field);
    }
    const column = (attr: string) => attributes[attr]?.field ?? attr;
    // The row scope: several fields (`rowScope.fields`), the one field, a shared master, or none (a path may come later).
    const rowScopeOf = (model: string): Pick<CatalogScope, 'row' | 'rowColumn' | 'rowColumns' | 'rowShared'> => {
      if (!rows) return { row: 'none' };
      if (free.has(model)) return { row: 'none', rowShared: true };
      const several = rows.fields?.[model];
      if (several) {
        const missing = several.filter((attr) => !(attr in attributes));
        if (missing.length) throw new Error(`reports.rowScope.fields: ${model} has no ${missing.join(', ')}`);
        const columns = several.map(column);
        return { row: 'own', rowColumn: columns[0], rowColumns: columns };
      }
      return rows.field in attributes ? { row: 'own', rowColumn: column(rows.field), rowColumns: [column(rows.field)] } : { row: 'none' };
    };
    const flag = (notes.softDeleteFlags ?? []).find((attr) => attr in attributes);
    const paranoid = model.options.paranoid ? (typeof model.options.deletedAt === 'string' ? model.options.deletedAt : 'deletedAt') : null;
    models[name] = {
      name,
      label: notes.labels?.[name] ?? label(name),
      // The table name only: the schema is the request's (`getTableName()` needs a tenant).
      table: model.tableName,
      fields,
      relations: [],
      scope: {
        company: PARTITION.field in attributes && !PARTITION.exempt.includes(name) ? column(PARTITION.field) : null,
        ...(PARTITION.exempt.includes(name) ? { companyShared: true } : {}),
        ...rowScopeOf(name),
        softDelete: flag ? { column: column(flag), kind: 'flag' } : paranoid ? { column: column(paranoid), kind: 'timestamp' } : null,
      },
    };
  }

  for (const [name, model] of Object.entries(statics)) {
    const entry = models[name];
    if (!entry) continue;
    for (const [as, assoc] of Object.entries(model.associations ?? {})) {
      const target = (assoc as unknown as { target?: ModelStatic<Model> }).target?.name;
      if (!target || !models[target]) continue;
      const a = assoc as unknown as { associationType: string; foreignKey: string; sourceKey?: string; targetKey?: string };
      let sourceKey: string;
      let targetKey: string;
      let type: 'one' | 'many';
      if (a.associationType === 'BelongsTo') {
        sourceKey = a.foreignKey;
        targetKey = a.targetKey ?? 'id';
        type = 'one';
      } else if (a.associationType === 'HasOne' || a.associationType === 'HasMany') {
        sourceKey = a.sourceKey ?? 'id';
        targetKey = a.foreignKey;
        type = a.associationType === 'HasOne' ? 'one' : 'many';
      } else {
        // Many-to-many goes through its own link model, which is in the catalog itself.
        continue;
      }
      // The association's scope narrows the target: without it a has-one joined every row (an account's every
      // address), repeating the source row. A scope that is not plain values is left out rather than joined too widely.
      const scope = (assoc as { scope?: Record<string, unknown> }).scope;
      const where = Object.entries(scope ?? {}).map(([field, value]) => ({ field, value }));
      if (!where.every((w) => w.value === null || ['string', 'number', 'boolean'].includes(typeof w.value))) continue;
      entry.relations.push({
        name: as,
        label: label(as),
        type,
        target,
        sourceKey,
        targetKey,
        ...(where.length ? { where: where as NonNullable<CatalogRelation['where']> } : {}),
      });
    }
  }

  // A model without the scope field reaches it through a belongs-to path: listed (`rowScope.paths`), or the header it is
  // named after (`InvoiceLine` → `invoice`).
  if (rows) {
    for (const entry of Object.values(models)) {
      if (entry.scope.row !== 'none' || free.has(entry.name)) continue;
      const header =
        rows.paths?.[entry.name] ??
        entry.relations.find(
          (relation) => relation.type === 'one' && models[relation.target]?.scope.row === 'own' && entry.name.startsWith(relation.target) && entry.name !== relation.target,
        )?.name;
      if (header) {
        entry.scope.row = 'path';
        entry.scope.rowPath = header;
      }
    }
  }

  const version = createHash('sha1').update(JSON.stringify(models)).digest('hex').slice(0, 12);
  return { version, models, ...(rows?.unscoped ? { unscoped: rows.unscoped } : {}), ...(rows ? { rowLabel: rows.label ?? scopeLabel(rows.field) } : {}) };
}

/** Words for a scope from its field: `branchId` → branch / branches, `regionCode` → region code / region codes. */
function scopeLabel(field: string): { one: string; many: string } {
  const one = field.replace(/Id$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const many = /(s|x|z|ch|sh)$/.test(one) ? `${one}es` : /[^aeiou]y$/.test(one) ? `${one.slice(0, -1)}ies` : `${one}s`;
  return { one, many };
}
