/**
 * Metadata a `crudController` leaves on its routes for the contract (`collectRoutes`): the class a create / update body
 * is held to when the operation has no `dto.ts`, and the list's query class.
 */
export const PAYLOAD_FALLBACK = 'ops:payload-fallback';

/** Marks the generic routes a CRUD resource expands into one entry per operation (`:name` actions, views, lookups). */
export const CRUD_ROUTE = 'ops:crud-route';

export type CrudRouteKind = 'create' | 'update' | 'list' | 'act' | 'actAll' | 'view' | 'lookup';
