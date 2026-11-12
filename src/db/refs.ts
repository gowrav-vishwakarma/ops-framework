import { NAMES } from '../naming.js';
import type { ModelIndexesOptions } from 'sequelize';
import type { TableOptions } from 'sequelize-typescript';

/**
 * What the move tool and the boot check need to know about ids that are not plain foreign keys.
 * A model declares each integer `...Id` column one of three ways: a real foreign key (`Fk()`, an
 * association or `ref()`), `@SoftRef('users')` (an id of another table with no database constraint),
 * or `@NotARef()` (not an id of a table the tenant owns).
 */
export interface SoftRefDef {
  table: string;
  /** `0` means "the system" and is never remapped (audit rows written by `systemCtx`). */
  zeroIsSystem: boolean;
}

/** model name -> attribute -> definition. */
export const SOFT_REFS = new Map<string, Map<string, SoftRefDef>>();
/** model name -> attributes that are not references. */
export const NOT_REFS = new Map<string, Set<string>>();

/** An id of another tenant table with no foreign key constraint (audit columns, polymorphic helpers). */
export function SoftRef(table: string, options: { zeroIsSystem?: boolean } = {}): PropertyDecorator {
  return (target, key) => {
    const name = target.constructor.name;
    const map = SOFT_REFS.get(name) ?? new Map<string, SoftRefDef>();
    map.set(String(key), { table, zeroIsSystem: options.zeroIsSystem ?? false });
    SOFT_REFS.set(name, map);
  };
}

/** Declarations of `model` and of every class it extends (audit columns live on the base class). */
export function softRefsOf(model: Function): Map<string, SoftRefDef> {
  const out = new Map<string, SoftRefDef>();
  const chain: Function[] = [];
  for (let c: Function | null = model; c && c.name; c = Object.getPrototypeOf(c) as Function | null) chain.unshift(c);
  for (const klass of chain) for (const [key, def] of SOFT_REFS.get(klass.name) ?? []) out.set(key, def);
  return out;
}

export function notRefsOf(model: Function): Set<string> {
  const out = new Set<string>();
  for (let c: Function | null = model; c && c.name; c = Object.getPrototypeOf(c) as Function | null) for (const key of NOT_REFS.get(c.name) ?? []) out.add(key);
  return out;
}

/** The column holds an integer that is not a reference to a row the tenant owns. */
export function NotARef(): PropertyDecorator {
  return (target, key) => {
    const name = target.constructor.name;
    const set = NOT_REFS.get(name) ?? new Set<string>();
    set.add(String(key));
    NOT_REFS.set(name, set);
  };
}

/** Polymorphic pair: `typeColumn` names the entity (model name), `idColumn` its id. */
export interface PolymorphicDef {
  typeColumn: string;
  idColumn: string;
  /** Entity type value -> table. Defaults to every tenant model name. */
  types?: Record<string, string>;
}

/** model name -> polymorphic pairs. */
export const POLYMORPHIC = new Map<string, PolymorphicDef[]>();

export function Polymorphic(def: PolymorphicDef): ClassDecorator {
  return (target) => {
    const list = POLYMORPHIC.get(target.name) ?? [];
    list.push(def);
    POLYMORPHIC.set(target.name, list);
  };
}

/** Declarations of `model` and of every class it extends. */
export function polymorphicOf(model: Function): PolymorphicDef[] {
  const out: PolymorphicDef[] = [];
  for (let c: Function | null = model; c && c.name; c = Object.getPrototypeOf(c) as Function | null) out.unshift(...(POLYMORPHIC.get(c.name) ?? []));
  return out;
}

/** table name -> natural key attribute, for reference tables (same rows in every schema). */
export const REFERENCE_TABLES = new Map<string, string>();

/**
 * A reference table: the same rows in every tenant schema, not partitioned (the permission
 * catalog). `naturalKey` is what a company move matches rows by instead of copying ids.
 */
export function referenceTable(tableName: string, naturalKey: string, indexes: ModelIndexesOptions[] = [], options: { underscored?: boolean } = {}): TableOptions {
  REFERENCE_TABLES.set(tableName, naturalKey);
  return { tableName, underscored: options.underscored ?? NAMES.underscored, timestamps: true, indexes };
}
