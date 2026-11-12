import { Inject, Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { CtxRequest } from '../auth/decorators.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';

/** What the server writes about each request (`FrameworkOptions.logging`). */
export interface LoggingOptions {
  /**
   * `off`; `basic`: one `request.start` and one `request.finish` line (method, URL, tenant, user,
   * status, time); `verbose`: also the request payload and the response body. Default `basic`.
   */
  http?: 'off' | 'basic' | 'verbose';
  /** Every SQL statement, on every pool (primary, control, shards), at debug level. Default false. */
  sql?: boolean;
  /** Each step and flow file of an operation with its time, at debug level. Default false. */
  steps?: boolean;
  /** Longest payload or body written, in characters. Default 4000. */
  bodyLimit?: number;
  /** Keys whose values are shortened (tokens) or hidden (passwords) in logged bodies. */
  redact?: { hide?: string[]; shorten?: string[] };
  /** Paths never logged (health checks). Default `['/api/health']`. */
  skip?: string[];
}

const HIDE = ['password', 'newPassword', 'oldPassword', 'secret', 'otp'];
const SHORTEN = ['accessToken', 'refreshToken', 'token', 'authorization', 'aiToken'];

/** A copy of `value` safe to log: hidden keys masked, long tokens cut to their start. */
export function redactForLog(value: unknown, hide: ReadonlySet<string>, shorten: ReadonlySet<string>, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, hide, shorten, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (hide.has(key)) out[key] = '[REDACTED]';
    else if (shorten.has(key) && typeof item === 'string') out[key] = item.length > 16 ? `${item.slice(0, 12)}…(${item.length})` : item;
    else out[key] = redactForLog(item, hide, shorten, depth + 1);
  }
  return out;
}

/** JSON of a logged body, cut at `limit` characters. */
export function bodyForLog(value: unknown, limit: number): unknown {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  if (text.length <= limit) return typeof value === 'string' ? value : JSON.parse(text);
  return `${text.slice(0, limit)}…(${text.length} chars)`;
}

/**
 * One line when a request starts and one when its response is sent, as JSON under the `HTTP`
 * context: method, URL, the tenant and user (once sign-in is checked), status and time, and with
 * `verbose` the payload and the response body, errors included. Secrets never reach the log.
 */
@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');
  private readonly mode: NonNullable<LoggingOptions['http']>;
  private readonly limit: number;
  private readonly hide: ReadonlySet<string>;
  private readonly shorten: ReadonlySet<string>;
  private readonly skip: ReadonlySet<string>;

  constructor(@Inject(FRAMEWORK_OPTIONS) options: FrameworkOptions) {
    const logging = options.logging ?? {};
    this.mode = logging.http ?? 'basic';
    this.limit = logging.bodyLimit ?? 4000;
    this.hide = new Set([...HIDE, ...(logging.redact?.hide ?? [])]);
    this.shorten = new Set([...SHORTEN, ...(logging.redact?.shorten ?? [])]);
    this.skip = new Set(logging.skip ?? ['/api/health']);
  }

  use(req: Request & CtxRequest, res: Response, next: NextFunction): void {
    const path = (req.originalUrl || req.url).split('?')[0] ?? '';
    if (this.mode === 'off' || this.skip.has(path)) return next();
    const started = performance.now();
    const verbose = this.mode === 'verbose';
    const base = { method: req.method, url: req.originalUrl || req.url };
    const start: Record<string, unknown> = { event: 'request.start', ...base };
    const companyHeader = req.headers['x-company-id'];
    if (companyHeader) start.companyId = companyHeader;
    if (verbose && req.body !== undefined && Object.keys(req.body ?? {}).length) start.payload = bodyForLog(redactForLog(req.body, this.hide, this.shorten), this.limit);
    this.logger.log(JSON.stringify(start));

    let body: unknown;
    if (verbose) {
      const send = res.send.bind(res);
      res.send = ((chunk: unknown) => {
        if (body === undefined) body = chunk;
        return send(chunk as never);
      }) as Response['send'];
    }
    res.on('finish', () => {
      const user = req.user as { id?: number; companyId?: number; tenantKey?: string | null } | undefined;
      const finish: Record<string, unknown> = { event: 'request.finish', ...base, statusCode: res.statusCode, durationMs: Math.round(performance.now() - started) };
      if (user?.companyId) finish.companyId = user.companyId;
      if (user?.tenantKey) finish.tenantId = user.tenantKey;
      if (user?.id) finish.userId = user.id;
      if (verbose && body !== undefined) {
        let parsed: unknown = body;
        if (typeof body === 'string') {
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = body;
          }
        } else if (Buffer.isBuffer(body)) parsed = `<${body.length} bytes>`;
        finish.response = bodyForLog(redactForLog(parsed, this.hide, this.shorten), this.limit);
      }
      const line = JSON.stringify(finish);
      if (res.statusCode >= 500) this.logger.error(line);
      else if (res.statusCode >= 400) this.logger.warn(line);
      else this.logger.log(line);
    });
    next();
  }
}

/** Sequelize `logging` for a pool: every statement at debug level, or nothing. */
export function sqlLogger(options: Pick<FrameworkOptions, 'logging'> | undefined, pool: string): false | ((sql: string, timing?: number) => void) {
  if (!options?.logging?.sql) return false;
  const logger = new Logger(`SQL:${pool}`);
  return (sql, timing) => logger.debug(timing === undefined ? sql : `${sql} (${timing} ms)`);
}
