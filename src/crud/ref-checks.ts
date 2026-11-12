import { literal, Op, QueryTypes, Utils, type Model, type ModelStatic, type WhereOptions } from 'sequelize';
import { currentTenant } from '../tenancy/context.js';
import { sequelizeOf } from '../tenancy/guards.js';
import { PARTITION } from '../tenancy/partition.js';
import type { Attrs, OpContext } from './op-context.js';

interface BelongsTo {
  associationType: string;
  foreignKey: string;
  targetKey?: string;
  as: string;
  target: ModelStatic<Model>;
}

const partitioned = (model: ModelStatic<Model>) => PARTITION.field in model.getAttributes() && !PARTITION.exempt.includes(model.name);

/**
 * A write's references stay inside its company: every foreign key the create sets, or the update
 * changes, that points at a company's table must name a row of the record's own company. The
 * database's foreign key only says the row exists (in a shared schema, maybe another company's).
 * One statement for all of them; a miss is a field error on the key. Empty keys (null, 0, '') and
 * shared tables (partition `exempt`) are left to the database.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function checkRefs(c: OpContext<any, Attrs, any, any>): Promise<void> {
  const row = c.row as Model;
  const model = row.constructor as ModelStatic<Model>;
  const company = (row.get(PARTITION.field) as number | undefined) ?? currentTenant()?.ref.companyId;
  if (!company) return;
  const probes: Array<{ field: string; label: string; target: ModelStatic<Model>; where: WhereOptions }> = [];
  for (const assoc of Object.values(model.associations ?? {}) as unknown as BelongsTo[]) {
    if (assoc.associationType !== 'BelongsTo' || !partitioned(assoc.target)) continue;
    const field = assoc.foreignKey;
    const value = row.get(field);
    if (value === null || value === undefined || value === '' || value === 0 || value === '0') continue;
    if (c.op !== 'create' && !row.changed(field as never)) continue;
    if (probes.some((p) => p.field === field)) continue;
    const key = assoc.targetKey ?? 'id';
    probes.push({ field, label: assoc.as.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase(), target: assoc.target, where: { [Op.and]: [{ [key]: value }, { [PARTITION.field]: company }] } });
  }
  if (!probes.length) return;
  const sequelize = sequelizeOf(c.t);
  const generator = (sequelize.getQueryInterface() as unknown as { queryGenerator: { selectQuery(table: unknown, options: object, model: unknown): string } }).queryGenerator;
  const parts = probes.map((probe, i) => {
    const options = Utils.mapOptionFieldNames({ attributes: [[literal('1'), 'x']], where: probe.where, limit: 1 } as never, probe.target as never);
    return `SELECT ${i} AS hit WHERE EXISTS (${generator.selectQuery(probe.target.getTableName(), options, probe.target).replace(/;\s*$/, '')})`;
  });
  const hits = new Set((await sequelize.query<{ hit: number }>(parts.join(' UNION ALL '), { type: QueryTypes.SELECT, transaction: c.t })).map((r) => Number(r.hit)));
  probes.forEach((probe, i) => {
    if (!hits.has(i)) c.issues.field(probe.field, `The selected ${probe.label} was not found.`);
  });
}
