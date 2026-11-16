import { ClsServiceManager } from 'nestjs-cls';
import type { Model, ModelStatic } from 'sequelize';

/**
 * Who is writing: the signed-in company user or admin of the running request, set by `JwtAuthGuard`. Every row a
 * request creates gets them as its creator (`createdById`), whichever code creates it (the operation's own record, a
 * step's child rows, a service's rows), so no endpoint stamps it. Portal and API-key requests, jobs and work outside
 * a request have no actor: nothing is stamped.
 */
const KEY = 'framework:actor';

export function setActor(id: number | null | undefined): void {
  if (id === null || id === undefined || !Number.isFinite(Number(id))) return;
  try {
    const cls = ClsServiceManager.getClsService();
    if (cls.isActive()) cls.set(KEY, Number(id));
  } catch {
    /* no request context */
  }
}

export function currentActor(): number | undefined {
  try {
    const cls = ClsServiceManager.getClsService();
    return cls.isActive() ? cls.get<number | undefined>(KEY) : undefined;
  } catch {
    return undefined;
  }
}

/** The creator attribute of a model (`createdById`, or `created_by_id` in a snake-case project), if it has one. */
export function creatorAttribute(model: ModelStatic<Model>): string | undefined {
  const attributes = model.getAttributes();
  return ['createdById', 'created_by_id'].find((name) => name in attributes);
}

/**
 * Fills the creator of every new row of `model` from the request's actor, single and bulk creates alike. A creator the
 * code set itself is kept.
 */
export function installCreatorStampHooks(model: ModelStatic<Model>): void {
  const attribute = creatorAttribute(model);
  if (!attribute) return;
  const fill = (row: Model) => {
    const actor = currentActor();
    if (actor === undefined || (row.get(attribute) !== null && row.get(attribute) !== undefined)) return;
    row.set(attribute, actor as never);
  };
  model.addHook('beforeValidate', 'framework:creator-stamp', ((row: Model) => {
    if (row.isNewRecord) fill(row);
  }) as never);
  model.addHook('beforeBulkCreate', 'framework:creator-stamp-bulk', ((rows: Model[]) => rows.forEach(fill)) as never);
}
