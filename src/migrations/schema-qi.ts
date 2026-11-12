import type { QueryInterface } from 'sequelize';

/** Methods whose first argument is a table name. `renameTable` also takes one as its second. */
const TABLE_FIRST = new Set([
  'createTable',
  'dropTable',
  'addColumn',
  'removeColumn',
  'changeColumn',
  'renameColumn',
  'describeTable',
  'addIndex',
  'removeIndex',
  'addConstraint',
  'removeConstraint',
  'showConstraint',
  'getForeignKeyReferencesForTable',
  'bulkInsert',
  'bulkUpdate',
  'bulkDelete',
  'upsert',
  'renameTable',
]);

/**
 * The QueryInterface of a migration, pinned to one schema. Sequelize puts `public.` in front of a
 * bare table name in several calls (`addColumn` describes the table first), so the `search_path`
 * of the transaction is not enough: every bare name becomes `{ tableName, schema }` here.
 */
export function schemaQueryInterface(qi: QueryInterface, schema: string): QueryInterface {
  const pin = (name: unknown) => (typeof name === 'string' ? { tableName: name, schema } : name);
  return new Proxy(qi, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function' || !TABLE_FIRST.has(String(property))) return typeof value === 'function' ? value.bind(target) : value;
      return (...args: unknown[]) => {
        args[0] = pin(args[0]);
        if (property === 'renameTable') args[1] = pin(args[1]);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}
