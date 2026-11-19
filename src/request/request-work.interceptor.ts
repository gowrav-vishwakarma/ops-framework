import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { finalize, throwError, type Observable } from 'rxjs';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { currentWork } from './request-work.js';
import { routeWork } from './slot.js';

/**
 * Starts the route's slot (counted from the request's start) and decides whether it only reads, from what the route
 * declares (`@Slot`, a CRUD route's operation, an action's `readOnly` / `slot`); the work ends with the handler.
 */
@Injectable()
export class RequestWorkInterceptor implements NestInterceptor {
  constructor(
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
    private readonly moduleRef: ModuleRef,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const work = context.getType() === 'http' ? currentWork() : undefined;
    if (!work) return next.handle();
    const req = context.switchToHttp().getRequest<{ params?: Record<string, string> }>();
    work.declare(routeWork(context, req, (token) => this.moduleRef.get(token, { strict: false })), this.options.requests);
    if (work.signal.aborted) return throwError(() => work.signal.reason as unknown);
    return next.handle().pipe(finalize(() => work.end()));
  }
}
