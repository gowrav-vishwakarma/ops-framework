import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Op, type FindAttributeOptions, type Includeable, type Model, type ModelStatic, type Order, type WhereOptions } from 'sequelize';

/**
 * A lookup of a resource (a party, product or account picker in a form): `GET /<resource>/lookups/<name>`.
 *
 * - Who: any member of the company; a user with a grant on the resource's list is narrowed by its scope (a grant for some
 *   branches); `permission` names an action whose grant is required instead.
 * - What: `fields` and `search` are the only fields a request may ask to show (`?fields=`) and to search (`?search=`,
 *   with `?q=`); `alias.field` names a field of an association (one level). Without them: `defaultFields` /
 *   `defaultSearch` (or all of the list).
 * - Its own rules (a branch scope, a special search, prices…) are steps in `ops/lookup-<name>/`, run as a list's.
 */
export interface LookupDef {
  fields: readonly string[];
  search: readonly string[];
  defaultFields?: readonly string[];
  defaultSearch?: readonly string[];
  /** Rows when the request names no limit (default 20); a request may ask up to `maxLimit` (default 100). */
  limit?: number;
  maxLimit?: number;
  /** Default `[[first default field, 'ASC']]`. */
  order?: Order;
  /** An action of the resource whose grant the caller needs (default: members of the company). */
  permission?: string;
  /** Fields a request may filter on (`?filters={"isActive":true,"branchId":[1,2]}`: a value, or a list of values). */
  filters?: readonly string[];
  /**
   * Named parameters the lookup's steps read (`?side=sales&date=2026-11-15`), typed; steps find them in
   * `c.state.params`. A query key the lookup does not declare is refused.
   */
  params?: Readonly<Record<string, LookupParamType>>;
  /** Conditions every request of the lookup has (a group, a kind): the server's, never the request's. */
  where?: WhereOptions;
  /**
   * Conditions for picking a new value only (active rows, valid on a date). Reading values already chosen (`?ids=`: an
   * old invoice opened for editing, its product inactive since) skips them; `where`, the company and the scope still
   * apply. Steps see `c.state.chosen` (true for such a read) and skip their own pick-only rules the same way.
   */
  pickable?: WhereOptions;
  /**
   * The lookup's steps search (a token search, an alias table...): `search` names are then the steps' own (not checked
   * against the model) and `q` is not applied by the framework; steps find `{ q, fields }` in `c.state.search`.
   */
  searchSteps?: boolean;
}

export type LookupParamType = 'text' | 'number' | 'boolean' | 'date' | 'ids';

export class LookupQueryDto {
  /** The text typed. */
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  /** Comma-separated fields to show (from the lookup's `fields`). */
  @IsOptional() @IsString() @MaxLength(2000) fields?: string;
  /** Comma-separated fields `q` searches (from the lookup's `search`). */
  @IsOptional() @IsString() @MaxLength(2000) search?: string;
  /** Comma-separated ids: the rows of values already chosen (a form opened for editing). */
  @IsOptional() @IsString() @MaxLength(2000) ids?: string;
  /** JSON object of conditions on the lookup's `filters` fields: a value, or a list of values. */
  @IsOptional() @IsString() @MaxLength(4000) filters?: string;
  /** Rows asked for; the lookup keeps it within its `maxLimit` (a picker asking 1000 gets its cap, not a refusal). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

const LOOKUP_KEYS = new Set(['q', 'fields', 'search', 'ids', 'filters', 'limit', 'offset']);

/** The lookup's named parameters from the request's query, typed; an undeclared key or a bad value is refused. */
export function lookupParams(def: LookupDef, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (LOOKUP_KEYS.has(key)) continue;
    const type = def.params?.[key];
    if (!type) throw new BadRequestException(`Unknown lookup parameter: ${key}`);
    const text = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
    if (text === '') continue;
    if (type === 'text') out[key] = text.slice(0, 500);
    else if (type === 'number') {
      const n = Number(text);
      if (!Number.isFinite(n)) throw new BadRequestException(`${key} must be a number`);
      out[key] = n;
    } else if (type === 'boolean') {
      if (text !== 'true' && text !== 'false') throw new BadRequestException(`${key} must be true or false`);
      out[key] = text === 'true';
    } else if (type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new BadRequestException(`${key} must be a date (YYYY-MM-DD)`);
      out[key] = text;
    } else {
      out[key] = list(text).map(Number).filter((id) => Number.isInteger(id) && id > 0);
    }
  }
  return out;
}

/** What one lookup request reads: columns, joins, conditions, page. */
export interface LookupFind {
  attributes: FindAttributeOptions;
  /** The chosen search fields and text, for a lookup whose steps search (`searchSteps`). */
  search: { q: string; fields: string[] };
  /** The request reads values already chosen (`?ids=`): pick-only rules do not apply. */
  chosen: boolean;
  include: Includeable[];
  where: WhereOptions[];
  order: Order;
  limit: number;
  offset: number;
}

const list = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

/** The requested names, each allowed by the lookup; a name it does not allow is refused (never silently dropped). */
function pick(requested: string | undefined, allowed: readonly string[], fallback: readonly string[] | undefined, what: string): string[] {
  const asked = list(requested);
  if (asked.length === 0) return [...(fallback ?? allowed)];
  const unknown = asked.filter((name) => !allowed.includes(name));
  if (unknown.length) throw new BadRequestException(`${what} not allowed in this lookup: ${unknown.join(', ')}`);
  return [...new Set(asked)];
}

/**
 * The find of one lookup request, checked against the lookup's lists and the model: plain fields become attributes,
 * `alias.field` an include of that association with its fields, `alias.alias.field` one nested in it (a branch's
 * billing address's state name); `q` is searched in the chosen search fields (any of them, case-insensitive), an
 * association's field through its include. Pure: the service adds the company and scope.
 */
export function buildLookupFind(model: ModelStatic<Model>, def: LookupDef, query: LookupQueryDto): LookupFind {
  const shown = pick(query.fields, def.fields, def.defaultFields, 'Fields');
  const searched = pick(query.search, def.search, def.defaultSearch, 'Search fields');
  const own = new Set<string>(['id']);
  /** The joins asked for, as a tree: alias -> its fields and the joins under it. */
  const joined = new Map<string, Join>();
  const place = (name: string) => {
    const parts = name.split('.');
    const field = parts.pop()!;
    if (!parts.length) {
      if (!model.getAttributes()[field]) throw new BadRequestException(`Unknown field ${name}`);
      own.add(field);
      return `${model.name}.${field}`;
    }
    let at = joined;
    let from: ModelStatic<Model> = model;
    let join: Join | undefined;
    for (const as of parts) {
      const association = from.associations[as];
      if (!association) throw new BadRequestException(`Unknown field ${name}`);
      join = at.get(as) ?? { model: association.target, fields: new Set(['id']), many: association.isMultiAssociation === true, under: new Map() };
      at.set(as, join);
      at = join.under;
      from = association.target;
    }
    if (!from.getAttributes()[field]) throw new BadRequestException(`Unknown field ${name}`);
    join!.fields.add(field);
    return `$${parts.join('.')}.${field}$`;
  };
  /** A to-many association (a branch's warehouses) is read as its own query: it cannot be searched or filtered through. */
  const throughMany = (name: string) => {
    let from: ModelStatic<Model> = model;
    for (const as of name.split('.').slice(0, -1)) {
      const association = from.associations[as];
      if (!association) return false;
      if (association.isMultiAssociation) return true;
      from = association.target;
    }
    return false;
  };
  const searchable = (name: string) => {
    if (throughMany(name)) throw new BadRequestException(`${name} lists many rows and cannot be searched or filtered`);
    return name;
  };
  shown.forEach(place);
  const searchRefs = def.searchSteps ? [] : searched.map((name) => place(searchable(name)));

  const ids = list(query.ids).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  const where: WhereOptions[] = def.where ? [def.where] : [];
  if (def.pickable && !ids.length) where.push(def.pickable);
  const text = query.q?.trim();
  if (text && searchRefs.length) {
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push({ [Op.or]: searchRefs.map((ref) => ({ [ref.startsWith('$') ? ref : ref.slice(model.name.length + 1)]: { [Op.iLike]: like } })) } as WhereOptions);
  }
  if (query.filters) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(query.filters);
    } catch {
      throw new BadRequestException('filters must be a JSON object');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BadRequestException('filters must be a JSON object');
    for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(def.filters ?? []).includes(field)) throw new BadRequestException(`Filter not allowed in this lookup: ${field}`);
      const ref = place(searchable(field));
      const key = ref.startsWith('$') ? ref : ref.slice(model.name.length + 1);
      const values = Array.isArray(value) ? value : [value];
      if (!values.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))) throw new BadRequestException(`Filter ${field} takes a value or a list of values`);
      where.push({ [key]: Array.isArray(value) ? { [Op.in]: values } : value } as WhereOptions);
    }
  }
  if (ids.length) where.push({ id: { [Op.in]: ids } });

  const limit = Math.min(query.limit ?? def.limit ?? 20, def.maxLimit ?? 100);
  const firstOwn = (def.defaultFields ?? def.fields).find((name) => !name.includes('.')) ?? 'id';
  return {
    attributes: [...own],
    search: { q: text ?? '', fields: searched },
    chosen: ids.length > 0,
    include: includesOf(model, joined),
    where,
    order: def.order ?? [[firstOwn, 'ASC']],
    limit: ids.length ? Math.max(limit, ids.length) : limit,
    offset: query.offset ?? 0,
  };
}

/** One join of a lookup: the associated model, its fields, whether it is to-many, and the joins under it. */
interface Join {
  model: ModelStatic<Model>;
  fields: Set<string>;
  many: boolean;
  under: Map<string, Join>;
}

/** The include of each join, its own joins nested in it; a to-many one read as its own query (with its key back). */
function includesOf(from: ModelStatic<Model>, joins: Map<string, Join>): Includeable[] {
  return [...joins].map(([as, join]): Includeable => {
    const nested = join.under.size ? { include: includesOf(join.model, join.under) } : {};
    if (!join.many) return { association: as, attributes: [...join.fields], required: false, ...nested };
    // A separate read needs the key back to its record.
    const foreignKey = (from.associations[as] as unknown as { foreignKey: string }).foreignKey;
    return { association: as, attributes: [...new Set([...join.fields, foreignKey])], separate: true, ...nested };
  });
}
