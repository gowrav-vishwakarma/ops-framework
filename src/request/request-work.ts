import { randomBytes } from 'node:crypto';
import { HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ClsServiceManager, type ClsService } from 'nestjs-cls';
import type { Sequelize } from 'sequelize-typescript';
import { cancelTagged } from './cancel-queries.js';

/**
 * How long an endpoint may run: `fast` (CRUD, lookups, saves), `medium` (reports), `slow` (exports, year-end close,
 * recalculations, imports). An endpoint declares its slot with `@Slot` (or an action's `slot`); the default is `fast`.
 */
export type SlotName = 'fast' | 'medium' | 'slow';

/** `FrameworkOptions.requests`: the slots' lengths in milliseconds. */
export interface RequestOptions {
  slots?: Partial<Record<SlotName, number>>;
}

export const DEFAULT_SLOTS: Readonly<Record<SlotName, number>> = { fast: 30_000, medium: 120_000, slow: 600_000 };

/** A slot's length under `options` (the defaults where the app sets none). */
export function slotMs(slot: SlotName, options?: RequestOptions): number {
  return options?.slots?.[slot] ?? DEFAULT_SLOTS[slot];
}

/** What a route does: how long it may run and whether it only reads (a read stops when its client leaves). */
export interface WorkDeclaration {
  slot?: SlotName;
  readOnly?: boolean;
}

/** The answer when a request ran past its slot: the write (if any) was rolled back. */
export class RequestTimedOut extends ServiceUnavailableException {
  constructor(slot?: SlotName) {
    super({ statusCode: 503, code: 'timeout', message: `This took too long${slot ? ` (over the ${slot} time limit)` : ''} and was stopped; nothing was saved. Narrow it down and try again.` });
  }
}

/** The client went away before the answer: a read stops (nobody is waiting for it). 499, as nginx names it; never sent. */
export class ClientGone extends HttpException {
  constructor() {
    super({ statusCode: 499, code: 'client_gone', message: 'The client left before the answer was ready' }, 499);
  }
}

/** Methods that only read when nothing else is declared. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const logger = new Logger('Requests');

/**
 * One HTTP request's work: its id (tagged on every query it sends), its abort signal, its slot and whether it only
 * reads. The signal fires when the slot runs out (reads and writes alike: a write is rolled back) or when a read's
 * client goes away (a write keeps running: it is short and atomic, and its answer may be replayed by its idempotency
 * key). On abort, the request's queries still running are cancelled by their tag on every database it touched.
 */
export class RequestWork {
  readonly id: string;
  readonly startedAt = Date.now();
  readonly signal: AbortSignal;
  slot: SlotName = 'fast';
  readOnly: boolean;
  /** When the slot ends (epoch ms); null until a route declares it. */
  deadline: number | null = null;
  /** Queries sent and not answered yet. */
  inFlight = 0;
  /** The operation (`<Model>.<op>`) and step file running now, named in the request's query tags; none outside a step. */
  at: { op?: string; step?: string } = {};
  /**
   * What the request did, for traces and test coverage: every operation it ran (`<Model>.<op>`) and every step file, in
   * order, with the conditional ones its `when` skipped (`ran: false`).
   */
  readonly operations = new Set<string>();
  readonly steps: Array<{ op: string; step: string; ran: boolean }> = [];
  private readonly controller = new AbortController();
  private readonly databases = new Map<string, Sequelize>();
  private timer: NodeJS.Timeout | null = null;
  private clientLeft = false;
  private ended = false;

  constructor(method: string, id = randomBytes(8).toString('hex')) {
    this.id = id;
    this.readOnly = READ_METHODS.has(method.toUpperCase());
    this.signal = this.controller.signal;
  }

  /** The route's slot and kind (`@Slot`, a CRUD route's operation, an action's declaration); the slot counts from the request's start. */
  declare(declaration: WorkDeclaration, options?: RequestOptions): void {
    if (declaration.readOnly !== undefined) this.readOnly = declaration.readOnly;
    if (declaration.slot) this.slot = declaration.slot;
    this.deadline = this.startedAt + slotMs(this.slot, options);
    this.arm();
    if (this.clientLeft && this.readOnly) this.abort(new ClientGone());
  }

  /** Milliseconds left in the slot, at least 1; null without a slot. */
  remainingMs(): number | null {
    return this.deadline === null ? null : Math.max(1, this.deadline - Date.now());
  }

  /** The response closed before it was sent: a read stops, a write carries on. */
  clientGone(): void {
    this.clientLeft = true;
    if (this.readOnly && !this.ended) this.abort(new ClientGone());
  }

  /** The answer is out (or the handler is done): no timer, no abort after this. */
  end(): void {
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Runs a step with its operation and file named in the tag of every statement it sends; the caller's come back after. */
  async within<T>(op: string, step: string, work: () => Promise<T>): Promise<T> {
    const outer = this.at;
    this.at = { op, step };
    this.steps.push({ op, step, ran: true });
    try {
      return await work();
    } finally {
      this.at = outer;
    }
  }

  /** An operation the request runs (`<Model>.<op>`), whether or not it has step files. */
  enter(op: string): void {
    this.operations.add(op);
  }

  /** A conditional step its `when` left out. */
  skip(op: string, step: string): void {
    this.steps.push({ op, step, ran: false });
  }

  /** A database the request sent a query to (cancelled there on abort). */
  touched(dbKey: string, sequelize: Sequelize): void {
    if (!this.databases.has(dbKey)) this.databases.set(dbKey, sequelize);
  }

  /** Stops the request: steps and new queries refuse, running queries are cancelled by their tag. */
  abort(reason: HttpException): void {
    if (this.signal.aborted) return;
    this.end();
    this.controller.abort(reason);
    void this.cancelRunning();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.ended || this.deadline === null) return;
    this.timer = setTimeout(() => this.abort(new RequestTimedOut(this.slot)), Math.max(0, this.deadline - Date.now()));
    this.timer.unref();
  }

  /**
   * Cancels the request's running queries from another connection, on every database it touched, outside the
   * request's context (the cancel is neither tagged nor refused). A query sent just before the abort may not be in
   * `pg_stat_activity` yet, so it tries again while one is still running.
   */
  private async cancelRunning(): Promise<void> {
    for (let attempt = 1; attempt <= 5 && this.inFlight > 0; attempt++) {
      await runOutsideRequest(() => Promise.all([...this.databases.values()].map((sequelize) => cancelTagged(sequelize, this.id)))).catch((error: unknown) =>
        logger.warn(`Cancelling the queries of request ${this.id} failed: ${error instanceof Error ? error.message : String(error)}`),
      );
      if (this.inFlight > 0) await new Promise((resolve) => setTimeout(resolve, 50 * attempt).unref());
    }
  }
}

const KEY = 'framework:request';

/** The running HTTP request's work, or undefined outside one (jobs, boot, tests). */
export function currentWork(): RequestWork | undefined {
  try {
    const cls = ClsServiceManager.getClsService();
    return cls.isActive() ? cls.get<RequestWork | undefined>(KEY) : undefined;
  } catch {
    return undefined;
  }
}

/** Never aborted: the signal of work outside a request. */
const NEVER = new AbortController().signal;

/** The running request's abort signal; outside a request one that never fires. */
export function requestSignal(): AbortSignal {
  return currentWork()?.signal ?? NEVER;
}

/** Runs `work` in a fresh context with no request: its queries are not the request's (no tag, no refusal). */
export function runOutsideRequest<T>(work: () => Promise<T>): Promise<T> {
  const cls = ClsServiceManager.getClsService();
  if (!cls.isActive()) return work();
  return cls.run({ ifNested: 'inherit' }, () => {
    cls.set(KEY, undefined);
    return work();
  });
}

/**
 * The CLS middleware's `setup`: every HTTP request gets its work under the request id the CLS generated. A response
 * that closes before it finished means the client went away.
 */
export function startRequestWork(cls: Pick<ClsService, 'set' | 'getId'>, req: { method: string }, res: { writableFinished: boolean; once(event: 'close' | 'finish', listener: () => void): unknown }): void {
  const work = new RequestWork(req.method, cls.getId());
  cls.set(KEY, work);
  byRequest.set(req, work);
  res.once('finish', () => work.end());
  res.once('close', () => {
    if (!res.writableFinished) work.clientGone();
  });
}

const byRequest = new WeakMap<object, RequestWork>();

/** A request's work by its request object, also after the response (what it ran: traces, test coverage). */
export function workOfRequest(req: object): RequestWork | undefined {
  return byRequest.get(req);
}

/** Request ids: hex, safe inside a SQL comment. */
export function newRequestId(): string {
  return randomBytes(8).toString('hex');
}
