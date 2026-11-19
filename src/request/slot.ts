import { SetMetadata, type ExecutionContext, type Type } from '@nestjs/common';
import { ROUTE_WORK } from '../payload/route-meta.js';
import type { SlotName, WorkDeclaration } from './request-work.js';

/** A route's work resolved per request: a CRUD action route asks its service for the action's declaration. */
export type WorkResolver = (req: { params?: Record<string, string> }, get: <T>(token: Type<T>) => T) => WorkDeclaration;

/**
 * The route's time slot (`fast` by default; `medium` for reports, `slow` for exports, closings, recalculations and
 * imports) and, for a POST that only reads (a report), `{ readOnly: true }`: a read stops when its client leaves, a
 * write never does. On a controller class it applies to each of its routes that declares none.
 *
 *   @Post('ledger-report') @Slot('medium', { readOnly: true })
 */
export function Slot(slot: SlotName, options: { readOnly?: boolean } = {}): MethodDecorator & ClassDecorator {
  return SetMetadata(ROUTE_WORK, { slot, ...options } satisfies WorkDeclaration);
}

/**
 * What the matched route declares: its controller's `@Slot` under the handler's own (or the CRUD route's meta, resolved
 * for this request). The work's own defaults apply to what stays undeclared (`fast`; a GET reads, anything else writes).
 */
export function routeWork(context: Pick<ExecutionContext, 'getHandler' | 'getClass'>, req: { params?: Record<string, string> }, get: <T>(token: Type<T>) => T): WorkDeclaration {
  const own = Reflect.getMetadata(ROUTE_WORK, context.getHandler()) as WorkDeclaration | WorkResolver | undefined;
  const controller = (Reflect.getMetadata(ROUTE_WORK, context.getClass()) ?? {}) as WorkDeclaration;
  return { ...controller, ...(typeof own === 'function' ? own(req, get) : own) };
}
