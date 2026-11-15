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
}

export class LookupQueryDto {
  /** The text typed. */
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  /** Comma-separated fields to show (from the lookup's `fields`). */
  @IsOptional() @IsString() @MaxLength(2000) fields?: string;
  /** Comma-separated fields `q` searches (from the lookup's `search`). */
  @IsOptional() @IsString() @MaxLength(2000) search?: string;
  /** Comma-separated ids: the rows of values already chosen (a form opened for editing). */
  @IsOptional() @IsString() @MaxLength(2000) ids?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/** What one lookup request reads: columns, joins, conditions, page. */
export interface LookupFind {
  attributes: FindAttributeOptions;
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
 * `alias.field` an include of that association with its fields; `q` is searched in the chosen search fields (any of
 * them, case-insensitive), an association's field through its include. Pure: the service adds the company and scope.
 */
export function buildLookupFind(model: ModelStatic<Model>, def: LookupDef, query: LookupQueryDto): LookupFind {
  const shown = pick(query.fields, def.fields, def.defaultFields, 'Fields');
  const searched = pick(query.search, def.search, def.defaultSearch, 'Search fields');
  const own = new Set<string>(['id']);
  const joined = new Map<string, Set<string>>();
  const place = (name: string) => {
    const [first, second] = name.split('.');
    if (!second) {
      if (!model.getAttributes()[first!]) throw new BadRequestException(`Unknown field ${name}`);
      own.add(first!);
      return `${model.name}.${first}`;
    }
    const target = model.associations[first!]?.target;
    if (!target || !target.getAttributes()[second]) throw new BadRequestException(`Unknown field ${name}`);
    joined.set(first!, (joined.get(first!) ?? new Set(['id'])).add(second));
    return `$${first}.${second}$`;
  };
  shown.forEach(place);
  const searchRefs = searched.map(place);

  const where: WhereOptions[] = [];
  const text = query.q?.trim();
  if (text && searchRefs.length) {
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push({ [Op.or]: searchRefs.map((ref) => ({ [ref.startsWith('$') ? ref : ref.slice(model.name.length + 1)]: { [Op.iLike]: like } })) } as WhereOptions);
  }
  const ids = list(query.ids).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length) where.push({ id: { [Op.in]: ids } });

  const limit = Math.min(query.limit ?? def.limit ?? 20, def.maxLimit ?? 100);
  const firstOwn = (def.defaultFields ?? def.fields).find((name) => !name.includes('.')) ?? 'id';
  return {
    attributes: [...own],
    include: [...joined].map(([as, fields]) => ({ association: as, attributes: [...fields], required: false })),
    where,
    order: def.order ?? [[firstOwn, 'ASC']],
    limit: ids.length ? Math.max(limit, ids.length) : limit,
    offset: query.offset ?? 0,
  };
}
