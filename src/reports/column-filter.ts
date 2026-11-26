/**
 * Shared column-header filter helpers for report action hooks.
 *
 * FilterTableHeader sends Sequelize-style `where` (`$iLike`, `$eq`, `$gt`, `$between`, …).
 * Each report maps its own column names to SQL:
 *
 *   buildColumnFilterClause(filters.where, (field) => { switch (field) { ... } }, replacements)
 *
 * Use `rowMatchesColumnWhere` only when some rows are assembled in JS (e.g. opening-stock lines).
 */

function collectWhereConditions(where: unknown): Array<Record<string, unknown>> {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return [];
  const obj = where as Record<string, unknown>;
  const out: Array<Record<string, unknown>> = [];
  if (Array.isArray(obj.$and)) {
    for (const part of obj.$and) out.push(...collectWhereConditions(part));
  }
  if (Array.isArray(obj.$or)) {
    for (const part of obj.$or) out.push(...collectWhereConditions(part));
  }
  for (const [key, value] of Object.entries(obj)) {
    if (key === '$and' || key === '$or') continue;
    out.push({ [key]: value });
  }
  return out;
}

/** `bindValue` returns the placeholder text for a value (`:name` for replacements, `$n` for bind params). */
function sequelizeOpToSqlGeneric(
  expr: string,
  opValue: unknown,
  bindValue: (value: unknown) => string,
  useAnyForArrays: boolean,
): string | null {
  if (opValue === null || opValue === undefined || opValue === '') return null;
  if (typeof opValue !== 'object' || Array.isArray(opValue)) {
    return `${expr} = ${bindValue(opValue)}`;
  }
  const opObj = opValue as Record<string, unknown>;
  const op = Object.keys(opObj)[0];
  const value = opObj[op as string];
  if (op == null || value === undefined || value === null || value === '') return null;

  if (op === '$iLike' || op === '$like' || op === '$contains' || op === '$startsWith' || op === '$endsWith') {
    return `${expr}::text ILIKE ${bindValue(value)}`;
  }
  if (op === '$in' || op === '$notIn') {
    const arr = Array.isArray(value) ? value : [value];
    if (arr.length === 0) return null;
    if (useAnyForArrays) {
      return `${op === '$notIn' ? 'NOT ' : ''}(${expr} = ANY(${bindValue(arr)}))`;
    }
    return `${expr} ${op === '$in' ? 'IN' : 'NOT IN'} (${bindValue(arr)})`;
  }
  if (op === '$eq') {
    return `${expr} = ${bindValue(value)}`;
  }
  if (op === '$gt') {
    return `${expr} > ${bindValue(value)}`;
  }
  if (op === '$lt') {
    return `${expr} < ${bindValue(value)}`;
  }
  if (op === '$gte') {
    return `${expr} >= ${bindValue(value)}`;
  }
  if (op === '$lte') {
    return `${expr} <= ${bindValue(value)}`;
  }
  if (op === '$between') {
    const range = Array.isArray(value)
      ? value
      : value && typeof value === 'object'
        ? [(value as { from?: unknown; to?: unknown }).from, (value as { from?: unknown; to?: unknown }).to]
        : [];
    if (range[0] == null || range[1] == null) return null;
    return `${expr} BETWEEN ${bindValue(range[0])} AND ${bindValue(range[1])}`;
  }
  return null;
}

function sequelizeOpToSql(
  expr: string,
  opValue: unknown,
  replacements: Record<string, unknown>,
  paramPrefix: string,
): string | null {
  let seq = 0;
  const bindValue = (value: unknown): string => {
    const key = seq === 0 ? paramPrefix : `${paramPrefix}_${seq}`;
    seq += 1;
    replacements[key] = value;
    return `:${key}`;
  };
  return sequelizeOpToSqlGeneric(expr, opValue, bindValue, false);
}

export function buildColumnFilterClause(
  where: unknown,
  fieldToExpr: (field: string) => string | null,
  replacements: Record<string, unknown>,
): string {
  const conditions = collectWhereConditions(where);
  const clauses: string[] = [];
  conditions.forEach((condition, index) => {
    const field = Object.keys(condition)[0];
    if (!field) return;
    const expr = fieldToExpr(field);
    if (!expr) return;
    const sql = sequelizeOpToSql(expr, condition[field], replacements, `colFilter${index}`);
    if (sql) clauses.push(sql);
  });
  return clauses.length ? clauses.join(' AND ') : '';
}

/** Same as buildColumnFilterClause for hooks that pass positional `bind` params instead of replacements. */
export function buildColumnFilterClauseBind(
  where: unknown,
  fieldToExpr: (field: string) => string | null,
  bindParams: unknown[],
): string {
  const clauses: string[] = [];
  for (const condition of collectWhereConditions(where)) {
    const field = Object.keys(condition)[0];
    if (!field) continue;
    const expr = fieldToExpr(field);
    if (!expr) continue;
    const sql = sequelizeOpToSqlGeneric(
      expr,
      condition[field],
      (value) => {
        bindParams.push(value);
        return `$${bindParams.length}`;
      },
      true,
    );
    if (sql) clauses.push(sql);
  }
  return clauses.length ? clauses.join(' AND ') : '';
}

function likePatternToTest(pattern: string, haystack: string): boolean {
  const needle = pattern.toLowerCase();
  const s = haystack.toLowerCase();
  if (needle.startsWith('%') && needle.endsWith('%') && needle.length >= 2) {
    return s.includes(needle.slice(1, -1));
  }
  if (needle.startsWith('%')) return s.endsWith(needle.slice(1));
  if (needle.endsWith('%')) return s.startsWith(needle.slice(0, -1));
  return s === needle;
}

function valueMatchesOp(rowValue: unknown, opValue: unknown): boolean {
  if (opValue === null || opValue === undefined || opValue === '') return true;
  if (typeof opValue !== 'object' || Array.isArray(opValue)) {
    return String(rowValue ?? '') === String(opValue);
  }
  const opObj = opValue as Record<string, unknown>;
  const op = Object.keys(opObj)[0];
  const value = opObj[op as string];
  if (op == null || value === undefined || value === null || value === '') return true;

  const asText = String(rowValue ?? '');
  const asNum = Number(rowValue);

  if (op === '$iLike' || op === '$like' || op === '$contains' || op === '$startsWith' || op === '$endsWith') {
    return likePatternToTest(String(value), asText);
  }
  if (op === '$eq') {
    if (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)))) {
      return asNum === Number(value);
    }
    return asText.toLowerCase() === String(value).toLowerCase();
  }
  if (op === '$gt') return asNum > Number(value);
  if (op === '$lt') return asNum < Number(value);
  if (op === '$gte') return asNum >= Number(value);
  if (op === '$lte') return asNum <= Number(value);
  if (op === '$in') {
    const arr = Array.isArray(value) ? value : [value];
    return arr.some((item) => String(item) === asText);
  }
  if (op === '$notIn') {
    const arr = Array.isArray(value) ? value : [value];
    return !arr.some((item) => String(item) === asText);
  }
  if (op === '$between') {
    const range = Array.isArray(value)
      ? value
      : value && typeof value === 'object'
        ? [(value as { from?: unknown; to?: unknown }).from, (value as { from?: unknown; to?: unknown }).to]
        : [];
    if (range[0] == null || range[1] == null) return true;
    return asNum >= Number(range[0]) && asNum <= Number(range[1]);
  }
  return true;
}

export function parseReportSort(
  filters: { order?: unknown; sortBy?: unknown; sortOrder?: unknown },
): { field: string; direction: 'ASC' | 'DESC' } | null {
  const fromTuple = (tuple: unknown): { field: string; direction: 'ASC' | 'DESC' } | null => {
    if (!Array.isArray(tuple) || typeof tuple[0] !== 'string' || tuple[0].length === 0) return null;
    return {
      field: tuple[0],
      direction: String(tuple[1] ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
    };
  };

  if (Array.isArray(filters.order) && filters.order.length > 0) {
    const parsed = fromTuple(filters.order[0]);
    if (parsed) return parsed;
  }
  if (typeof filters.sortBy === 'string' && filters.sortBy.length > 0) {
    return {
      field: filters.sortBy,
      direction: String(filters.sortOrder ?? 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC',
    };
  }
  return null;
}

/** Whitelisted ASC/DESC for a named column; used by report table-header sort. */
export function reportSortDirection(
  filters: { order?: unknown; sortBy?: unknown; sortOrder?: unknown },
  field: string,
  fallback: 'ASC' | 'DESC' = 'DESC',
): 'ASC' | 'DESC' {
  const sort = parseReportSort(filters);
  if (sort && sort.field === field) return sort.direction;
  return fallback;
}

export function rowMatchesColumnWhere(
  row: Record<string, unknown>,
  where: unknown,
): boolean {
  const conditions = collectWhereConditions(where);
  if (conditions.length === 0) return true;
  return conditions.every((condition) => {
    const field = Object.keys(condition)[0];
    if (!field) return true;
    return valueMatchesOp(row[field], condition[field]);
  });
}

/**
 * Keep only where conditions whose field exists on `row`.
 * Returns null when nothing remains (caller should treat as "no column filter").
 * Used when a shared fetchOptions.where may include another tab's columns.
 */
export function scopeColumnWhereToRowFields(
  where: unknown,
  row: Record<string, unknown>,
): Record<string, unknown> | null {
  const conditions = collectWhereConditions(where);
  if (conditions.length === 0) return null;
  const scoped: Record<string, unknown> = {};
  for (const condition of conditions) {
    const field = Object.keys(condition)[0];
    if (!field || !(field in row)) continue;
    scoped[field] = condition[field];
  }
  return Object.keys(scoped).length > 0 ? scoped : null;
}
