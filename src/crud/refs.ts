import type { ModelStatic, Transaction, WhereOptions } from 'sequelize';
import type { Model } from 'sequelize-typescript';
import { fieldErrors, type FieldErrors } from '../errors.js';

export interface RefCheck {
  /** DTO field, shown in the error. */
  field: string;
  model: ModelStatic<Model>;
  id: number | null | undefined;
  /** Extra match such as `{ subtype: 'driver' }`. */
  where?: WhereOptions;
  label?: string;
}

/**
 * Every referenced row must exist in the caller's company (and match `where`).
 * One 422 lists all bad fields, so a form can mark them together.
 */
export async function assertRefs(companyId: number, checks: RefCheck[], t: Transaction): Promise<void> {
  const errors: FieldErrors = {};
  await Promise.all(
    checks
      .filter((check) => check.id !== undefined && check.id !== null)
      .map(async (check) => {
        const found = await check.model.count({
          where: { id: check.id, companyId, ...check.where } as WhereOptions,
          transaction: t,
        });
        if (!found) errors[check.field] = [`${check.label ?? 'Record'} not found`];
      }),
  );
  if (Object.keys(errors).length) throw fieldErrors(errors);
}
