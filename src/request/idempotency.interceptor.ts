import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnprocessableEntityException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA, INTERCEPTORS_METADATA } from '@nestjs/common/constants.js';
import { catchError, from, mergeMap, of, switchMap, throwError, type Observable } from 'rxjs';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { IdempotencyStore } from './idempotency-store.js';
import { currentWork, slotMs } from './request-work.js';

export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');
/** The request header a client sends with a save: a UUID per submitted save, the same on its retries. */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
/** Set on an answer that is the first save's answer sent again. */
export const REPLAYED_HEADER = 'Idempotent-Replayed';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long past its slot the first save holds its key (a crashed pod frees it then). */
const HOLD_MARGIN_MS = 60_000;

interface KeyedRequest {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: unknown;
  /** Uploaded files (multer): a list, or lists by field. */
  files?: UploadedFile[] | Record<string, UploadedFile[]>;
  user?: { id?: number; companyId?: number | null };
}

/** A file multer parsed from a multipart save. */
interface UploadedFile {
  fieldname: string;
  originalname?: string;
  size?: number;
  buffer?: Buffer;
}

/** The request was seen by an idempotency interceptor already (the global one, before a route's own). */
const SEEN = Symbol('framework.idempotencySeen');

/** JSON with every object's keys sorted: the same body in another key order is the same body. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
  return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

/** Each uploaded file as its field, name, size and a hash of its content, in a stable order. */
function filesDigest(files: KeyedRequest['files']): string[] {
  const list = Array.isArray(files) ? files : Object.values(files ?? {}).flat();
  return list
    .map((file) => [file.fieldname, file.originalname ?? '', file.size ?? file.buffer?.length ?? 0, file.buffer ? createHash('sha256').update(file.buffer).digest('hex') : ''].join(':'))
    .sort();
}

/** What a save with a key is compared by: its body, its query (`confirm`, filters) and its uploaded files. */
export function requestHash(req: Pick<KeyedRequest, 'body' | 'query' | 'files'>): string {
  return createHash('sha256').update(canonicalJson({ body: req.body ?? null, query: req.query ?? {}, files: filesDigest(req.files) })).digest('hex');
}

/** Whose key it is: company, user, method and path, then the key (one user's key never touches another's save). */
export function idempotencyScope(prefix: string, req: KeyedRequest, key: string): string {
  const path = (req.originalUrl || req.url).split('?')[0];
  return `${prefix}idempotency:${req.user?.companyId ?? 0}:${req.user?.id ?? 0}:${req.method.toUpperCase()}:${path}:${key.toLowerCase()}`;
}

/**
 * Idempotent saves: a write (create, update, delete, a write action) sent with `Idempotency-Key` runs once per key.
 * The same key with the same body answers the first save's answer again (`Idempotent-Replayed: true`); while the
 * first still runs, 409 `save_in_progress`; with another body, 422 `idempotency_key_reused`; a failed first save
 * frees its key. A route that parses uploads in its own interceptor lists this one after it
 * (`UseInterceptors(AnyFilesInterceptor(), IdempotencyInterceptor, …)`): the global one then leaves the request to it,
 * so the files are compared too. No key: as without this. No Redis (`FrameworkOptions.idempotency.redis`): keys are ignored, logged
 * once; Redis unreachable: the save runs without the check, logged once per outage.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Idempotency');
  private readonly prefix: string;
  private warnedOff = false;
  private down = false;

  constructor(
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
    @Optional() @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore | null = null,
  ) {
    this.prefix = options.idempotency?.prefix ?? '';
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<KeyedRequest & { [SEEN]?: boolean }>();
    const first = !req[SEEN];
    req[SEEN] = true;
    if (first && this.declaredByRoute(context)) return next.handle();
    const raw = req.headers[IDEMPOTENCY_HEADER.toLowerCase()];
    const key = Array.isArray(raw) ? raw[0] : raw;
    const work = currentWork();
    if (key === undefined || !work || work.readOnly) return next.handle();
    if (!UUID.test(key)) return throwError(() => new BadRequestException({ statusCode: 400, code: 'idempotency_key_invalid', message: `${IDEMPOTENCY_HEADER} must be a UUID` }));
    const store = this.store;
    if (!store) {
      if (!this.warnedOff) this.logger.warn(`${IDEMPOTENCY_HEADER} sent but no Redis is configured (idempotency.redis): saves are not deduplicated`);
      this.warnedOff = true;
      return next.handle();
    }
    const scope = idempotencyScope(this.prefix, req, key);
    const hash = requestHash(req);
    const holdMs = (work.remainingMs() ?? slotMs(work.slot, this.options.requests)) + HOLD_MARGIN_MS;
    return from(this.reach(() => store.start(scope, hash, holdMs))).pipe(
      switchMap((start) => {
        if (start === undefined) return next.handle();
        switch (start.state) {
          case 'running':
            throw new ConflictException({ statusCode: 409, code: 'save_in_progress', message: 'This save is still running; wait a moment and look again before saving again.' });
          case 'reused':
            throw new UnprocessableEntityException({ statusCode: 422, code: 'idempotency_key_reused', message: `This ${IDEMPOTENCY_HEADER} was used for a different save; send a new key for a new save.` });
          case 'replay':
            context.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>().setHeader(REPLAYED_HEADER, 'true');
            return of(start.body);
        }
        const status = (Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) as number | undefined) ?? (req.method.toUpperCase() === 'POST' ? 201 : 200);
        return next.handle().pipe(
          mergeMap((body) => from(this.reach(() => store.finish(scope, hash, status, body))).pipe(mergeMap(() => of(body)))),
          catchError((error: unknown) => from(this.reach(() => store.release(scope))).pipe(mergeMap(() => throwError(() => error)))),
        );
      }),
    );
  }

  /** The route runs this check itself, after its own interceptors (a file upload's). */
  private declaredByRoute(context: ExecutionContext): boolean {
    const listed = [context.getHandler(), context.getClass()].flatMap((target) => (Reflect.getMetadata(INTERCEPTORS_METADATA, target) ?? []) as unknown[]);
    return listed.includes(IdempotencyInterceptor);
  }

  /** A Redis call; when Redis cannot be reached, undefined (the save goes on unchecked), logged once per outage. */
  private async reach<T>(call: () => Promise<T>): Promise<T | undefined> {
    try {
      const answer = await call();
      if (this.down) this.logger.log('Redis reachable again: saves are deduplicated');
      this.down = false;
      return answer;
    } catch (error) {
      if (!this.down) this.logger.warn(`Redis unreachable (${error instanceof Error ? error.message : String(error)}): saves are not deduplicated until it is back`);
      this.down = true;
      return undefined;
    }
  }
}
