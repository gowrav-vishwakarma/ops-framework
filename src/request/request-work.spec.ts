import { EventEmitter } from 'node:events';
import { Controller, Get, HttpException, Post, type ArgumentsHost } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { crudController } from '../crud/crud-controller.js';
import { CrudService } from '../crud/crud.service.js';
import { OpsRegistry, type LoadedStep } from '../crud/ops-loader.js';
import { ErrorAnswerFilter } from '../database-errors.js';
import { CANCEL_TAGGED_SQL, cancelPattern, cancelTagged, queryTag } from './cancel-queries.js';
import { IdempotencyStore, type IdempotencyRedis } from './idempotency-store.js';
import { canonicalJson, idempotencyScope, requestHash } from './idempotency.interceptor.js';
import { RequestAbortedError, tagRequestQueries } from './query-tag.js';
import { ClientGone, currentWork, RequestTimedOut, RequestWork, requestSignal, slotMs, startRequestWork } from './request-work.js';
import { routeWork, Slot } from './slot.js';

/**
 * Request abort, time slots and idempotent saves (`request/`): a new file because nothing before was about a request's
 * life. The database side (cancel by tag on a real Postgres, rollback, the pool) is proved by the app's e2e.
 */

/** A response as the CLS middleware sees it: closes, finishes. */
class FakeResponse extends EventEmitter {
  writableFinished = false;
  finish() {
    this.writableFinished = true;
    this.emit('finish');
    this.emit('close');
  }
}

/** Runs `work` inside an HTTP request's context (as the CLS middleware's `setup` starts it), with its work and response. */
function inRequest<T>(method: string, work: (ctx: { work: RequestWork; res: FakeResponse }) => Promise<T> | T, id = 'a1b2c3d4'): Promise<T> {
  const cls = ClsServiceManager.getClsService();
  return cls.run(async () => {
    const res = new FakeResponse();
    startRequestWork({ set: (key: string, value: unknown) => cls.set(key, value), getId: () => id } as never, { method }, res);
    return work({ work: currentWork()!, res });
  });
}

/** A pg client that answers every statement after `ms`, recording the text it was sent. */
function fakeClient(ms = 0) {
  const sent: string[] = [];
  const client = {
    query(config: unknown, ...rest: unknown[]) {
      const callback = rest.pop() as (error: unknown, result?: unknown) => void;
      sent.push(typeof config === 'string' ? config : (config as { text: string }).text);
      setTimeout(() => callback(null, { rows: [] }), ms);
    },
  };
  tagRequestQueries(client);
  const run = (sql: string) => new Promise((resolve, reject) => client.query(sql, (error: unknown, result: unknown) => (error ? reject(error) : resolve(result))));
  return { sent, run };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the request abort signal', () => {
  it('a read stops when its client leaves; a write carries on (it is short and atomic)', async () => {
    await inRequest('GET', ({ work, res }) => {
      expect(requestSignal()).toBe(work.signal);
      res.emit('close');
      expect(work.signal.aborted).toBe(true);
      expect(work.signal.reason).toBeInstanceOf(ClientGone);
    });
    await inRequest('POST', ({ work, res }) => {
      res.emit('close');
      expect(work.signal.aborted).toBe(false);
    });
  });

  it('a POST declared a read (a report) stops even when the client left before the route was known', async () => {
    await inRequest('POST', ({ work, res }) => {
      res.emit('close');
      work.declare({ readOnly: true, slot: 'medium' });
      expect(work.signal.reason).toBeInstanceOf(ClientGone);
    });
  });

  it('an answered request never aborts: its close after the finish is not a client leaving', async () => {
    await inRequest('GET', ({ work, res }) => {
      res.finish();
      expect(work.signal.aborted).toBe(false);
    });
  });

  it('outside a request the signal never fires (jobs, boot)', () => {
    expect(currentWork()).toBeUndefined();
    expect(requestSignal().aborted).toBe(false);
  });

  it('the slot counts from the start and aborts reads and writes alike with 503 timeout; an answer in time clears it', async () => {
    vi.useFakeTimers();
    await inRequest('POST', ({ work }) => {
      work.declare({ slot: 'fast' }, { slots: { fast: 1_000 } });
      vi.advanceTimersByTime(999);
      expect(work.signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(work.signal.reason).toBeInstanceOf(RequestTimedOut);
      expect((work.signal.reason as HttpException).getStatus()).toBe(503);
      expect((work.signal.reason as HttpException).getResponse()).toMatchObject({ code: 'timeout' });
    });
    await inRequest('GET', ({ work, res }) => {
      work.declare({}, { slots: { fast: 1_000 } });
      res.finish();
      vi.advanceTimersByTime(5_000);
      expect(work.signal.aborted).toBe(false);
    });
  });
});

describe('time slots', () => {
  it('fast 30 s, medium 120 s, slow 10 min unless the app sets them', () => {
    expect([slotMs('fast'), slotMs('medium'), slotMs('slow')]).toEqual([30_000, 120_000, 600_000]);
    expect(slotMs('medium', { slots: { medium: 5_000 } })).toBe(5_000);
    expect(slotMs('fast', { slots: { medium: 5_000 } })).toBe(30_000);
  });

  @Slot('medium')
  @Controller('reports')
  class ReportsController {
    @Post('ledger') @Slot('medium', { readOnly: true }) ledger() {}
    @Post('export') @Slot('slow') export() {}
    @Get('plain') plain() {}
  }
  @Controller('plain')
  class PlainController {
    @Post() save() {}
  }
  const at = (controller: object, handler: string) => ({ getClass: () => controller as never, getHandler: () => (controller as { prototype: Record<string, () => void> }).prototype[handler]! });
  const none = () => {
    throw new Error('no service');
  };

  it("a route's @Slot over its controller's; nothing declared stays to the work's defaults", () => {
    expect(routeWork(at(ReportsController, 'ledger'), {}, none)).toEqual({ slot: 'medium', readOnly: true });
    expect(routeWork(at(ReportsController, 'export'), {}, none)).toEqual({ slot: 'slow' });
    expect(routeWork(at(ReportsController, 'plain'), {}, none)).toEqual({ slot: 'medium' });
    expect(routeWork(at(PlainController, 'save'), {}, none)).toEqual({});
    expect(new RequestWork('GET').readOnly).toBe(true);
    expect(new RequestWork('POST').readOnly).toBe(false);
  });

  it('CRUD routes: lists, reads, views and lookups read; create, update, delete write; an action says itself (readOnly, slot)', () => {
    class ThingService {}
    const actions: Record<string, object> = { cancel: { name: 'cancel' }, trialBalance: { name: 'trialBalance', readOnly: true, slot: 'medium' }, export: { name: 'export', readOnly: true, slot: 'slow' } };
    const service = { actionDef: (name: string) => actions[name] };
    const Base = crudController({ resource: 'thing', service: ThingService as never, create: Object as never, update: Object as never });
    const get = <T>(token: unknown) => (token === ThingService ? service : none()) as T;
    const work = (handler: string, params: Record<string, string> = {}) => routeWork(at(Base, handler), { params }, get);
    expect(['list', 'get', 'view', 'lookup', 'history', 'actions'].map((h) => work(h))).toEqual(Array(6).fill({ readOnly: true }));
    expect(['create', 'update', 'remove'].map((h) => work(h))).toEqual(Array(3).fill({ readOnly: false }));
    expect(work('act', { name: 'cancel' })).toEqual({ readOnly: false });
    expect(work('actAll', { name: 'trialBalance' })).toEqual({ readOnly: true, slot: 'medium' });
    expect(work('actAll', { name: 'export' })).toEqual({ readOnly: true, slot: 'slow' });
  });
});

describe('the step runner stops on abort', () => {
  /** A CRUD service with only its step registry (the runner needs nothing else). */
  const runner = (steps: LoadedStep[]) => Object.assign(Object.create(CrudService.prototype) as object, { ops: new OpsRegistry(new Map([['report', steps]])), opsDir: null }) as unknown as { runPhase(c: object, phase: string): Promise<void> };

  it('runs the steps in order and stops before the next step once the signal fired; the reason is what is thrown', async () => {
    const ran: string[] = [];
    const controller = new AbortController();
    const step = (file: string, work: () => void): LoadedStep => ({ file, number: Number(file.slice(0, 3)), phase: 'check', impl: { check: async () => work() } });
    const steps = [step('010-check-read', () => ran.push('read')), step('020-check-slow', () => (ran.push('slow'), controller.abort(new RequestTimedOut('medium')))), step('030-check-later', () => ran.push('later'))];
    const c = { op: 'report', signal: controller.signal };
    await expect(runner(steps).runPhase(c, 'check')).rejects.toBeInstanceOf(RequestTimedOut);
    expect(ran).toEqual(['read', 'slow']);
  });

  it('without an abort every step runs', async () => {
    const ran: string[] = [];
    const steps = ['010', '020'].map((n): LoadedStep => ({ file: `${n}-check-x`, number: Number(n), phase: 'check', impl: { check: async () => void ran.push(n) } }));
    await runner(steps).runPhase({ op: 'report', signal: new AbortController().signal }, 'check');
    expect(ran).toEqual(['010', '020']);
  });
});

describe('query tags', () => {
  it("inside a request every statement starts with the request's tag; outside one nothing changes", async () => {
    const pg = fakeClient();
    await inRequest('GET', async () => {
      await pg.run('SELECT 1');
      await pg.run('INSERT INTO t VALUES (1)');
    });
    await pg.run('SELECT 2');
    expect(pg.sent).toEqual(['/* r:a1b2c3d4 */ SELECT 1', '/* r:a1b2c3d4 */ INSERT INTO t VALUES (1)', 'SELECT 2']);
  });

  it("a transaction's start carries SET LOCAL statement_timeout of the slot's time left (never a session SET)", async () => {
    vi.useFakeTimers();
    const pg = fakeClient();
    await inRequest('POST', async ({ work }) => {
      work.declare({ slot: 'medium' }, { slots: { medium: 120_000 } });
      vi.advanceTimersByTime(20_000);
      const started = pg.run('START TRANSACTION;');
      vi.advanceTimersByTime(1);
      await started;
    });
    expect(pg.sent).toEqual(['/* r:a1b2c3d4 */ START TRANSACTION; SET LOCAL statement_timeout = 100000']);
    expect(pg.sent.join()).not.toMatch(/(^|;\s*)SET statement_timeout/);
  });

  it('a client is wrapped once however often the hook sees it; outside a request its statements go as they are', async () => {
    const pg = fakeClient();
    const client = { query: (...args: unknown[]) => (args.pop() as (e: unknown, r: unknown) => void)(null, { rows: [] }) };
    tagRequestQueries(client);
    const wrapped = client.query;
    tagRequestQueries(client);
    expect(client.query).toBe(wrapped);
    await pg.run('SELECT 1');
    expect(pg.sent).toEqual(['SELECT 1']);
  });

  it('two requests at once each tag their own statements', async () => {
    const pg = fakeClient(5);
    await Promise.all([inRequest('GET', () => pg.run('SELECT 1'), 'aaaa'), inRequest('GET', () => pg.run('SELECT 2'), 'bbbb')]);
    expect(pg.sent.sort()).toEqual(['/* r:aaaa */ SELECT 1', '/* r:bbbb */ SELECT 2']);
  });

  it('once aborted, a new statement is refused (with the reason) but a rollback still goes; statements running are counted', async () => {
    const pg = fakeClient(20);
    await inRequest('GET', async ({ work }) => {
      const running = pg.run('SELECT pg_sleep(1)');
      expect(work.inFlight).toBe(1);
      await running;
      expect(work.inFlight).toBe(0);
      work.abort(new RequestTimedOut());
      const refused = await pg.run('SELECT 1').catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(RequestAbortedError);
      expect((refused as RequestAbortedError).reason).toBe(work.signal.reason);
      await pg.run('ROLLBACK;');
    });
    expect(pg.sent).toEqual(['/* r:a1b2c3d4 */ SELECT pg_sleep(1)', '/* r:a1b2c3d4 */ ROLLBACK;']);
  });
});

describe('cancel by tag', () => {
  /** Postgres LIKE, for the pattern the cancel sends. */
  const like = (text: string, pattern: string) => new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 's').test(text);

  it("targets only the request's own tagged statements, from another connection (never itself), by tag not process id", async () => {
    const asked: Array<{ sql: string; bind: unknown }> = [];
    const sequelize = { query: async (sql: string, options: { bind: unknown }) => (asked.push({ sql, bind: options.bind }), [{ cancelled: true }]) };
    expect(await cancelTagged(sequelize as never, 'a1b2c3d4')).toBe(1);
    expect(asked).toEqual([{ sql: CANCEL_TAGGED_SQL, bind: ['/* r:a1b2c3d4 */%'] }]);
    expect(CANCEL_TAGGED_SQL).toContain('pid <> pg_backend_pid()');
    const pattern = cancelPattern('a1b2c3d4');
    expect(like(`${queryTag('a1b2c3d4')}SELECT pg_sleep(5)`, pattern)).toBe(true);
    // Another request's statements, one whose id starts the same, and untagged ones are left alone.
    expect(like(`${queryTag('a1b2c3d4ff')}SELECT pg_sleep(5)`, pattern)).toBe(false);
    expect(like(`${queryTag('ffff0000')}SELECT pg_sleep(5)`, pattern)).toBe(false);
    expect(like('SELECT pg_sleep(5) /* r:a1b2c3d4 */', pattern)).toBe(false);
    expect(() => cancelPattern("x' OR 1=1 --")).toThrow(/Bad request id/);
  });
});

describe('an aborted request answers why it stopped', () => {
  const host = () => {
    const sent: { status?: number; body?: unknown } = {};
    const res = { headersSent: false, status: (s: number) => ((sent.status = s), res), json: (b: unknown) => (sent.body = b) };
    return { sent, host: { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost };
  };

  it('over its slot: 503 timeout, whatever the stop broke on the way (a cancelled query, a refused one)', async () => {
    const { sent, host: h } = host();
    await inRequest('POST', ({ work }) => {
      work.abort(new RequestTimedOut('fast'));
      new ErrorAnswerFilter().catch(new Error('canceling statement due to user request'), h);
    });
    expect(sent.status).toBe(503);
    expect(sent.body).toMatchObject({ statusCode: 503, code: 'timeout' });
  });

  it('a statement timeout (the database net) is the same 503 timeout', async () => {
    const { DatabaseError } = await import('sequelize');
    const { sent, host: h } = host();
    new ErrorAnswerFilter().catch(new DatabaseError(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) as never), h);
    expect(sent).toMatchObject({ status: 503, body: { code: 'timeout' } });
  });

  it('the client left: nothing is answered', async () => {
    const { sent, host: h } = host();
    await inRequest('GET', ({ res }) => {
      res.emit('close');
      new ErrorAnswerFilter().catch(new Error('cancelled'), h);
    });
    expect(sent).toEqual({});
  });
});

/** Redis as the store uses it: SET with PX and NX, GET, DEL, keys expiring by a clock. */
function fakeRedis() {
  let now = 0;
  const keys = new Map<string, { value: string; until: number }>();
  const live = (key: string) => {
    const hit = keys.get(key);
    if (hit && hit.until <= now) keys.delete(key);
    return keys.get(key);
  };
  const redis: IdempotencyRedis = {
    set: (async (key: string, value: string, _px: 'PX', ms: number, nx?: 'NX') => {
      if (nx && live(key)) return null;
      keys.set(key, { value, until: now + ms });
      return 'OK';
    }) as IdempotencyRedis['set'],
    get: async (key) => live(key)?.value ?? null,
    del: async (key) => keys.delete(key),
  };
  return { redis, keys, tick: (ms: number) => (now += ms) };
}

describe('idempotency store', () => {
  it('the first save holds the key; while it runs, the same key and body is still running; then its answer replays', async () => {
    const { redis } = fakeRedis();
    const store = new IdempotencyStore(redis);
    expect(await store.start('k', 'h1', 90_000)).toEqual({ state: 'first' });
    expect(await store.start('k', 'h1', 90_000)).toEqual({ state: 'running' });
    await store.finish('k', 'h1', 201, { id: 7 });
    expect(await store.start('k', 'h1', 90_000)).toEqual({ state: 'replay', status: 201, body: { id: 7 } });
  });

  it('the same key with another body is refused as reused, running or done', async () => {
    const store = new IdempotencyStore(fakeRedis().redis);
    await store.start('k', 'h1', 90_000);
    expect(await store.start('k', 'h2', 90_000)).toEqual({ state: 'reused' });
    await store.finish('k', 'h1', 201, { id: 7 });
    expect(await store.start('k', 'h2', 90_000)).toEqual({ state: 'reused' });
  });

  it('a failed save gives its key back: a corrected retry runs as the first', async () => {
    const store = new IdempotencyStore(fakeRedis().redis);
    await store.start('k', 'h1', 90_000);
    await store.release('k');
    expect(await store.start('k', 'h2', 90_000)).toEqual({ state: 'first' });
  });

  it('a save that never finished (its pod died) frees the key after its hold; an answer is kept 24 h', async () => {
    const { redis, tick } = fakeRedis();
    const store = new IdempotencyStore(redis);
    await store.start('lost', 'h1', 90_000);
    tick(90_000);
    expect(await store.start('lost', 'h1', 90_000)).toEqual({ state: 'first' });
    await store.finish('lost', 'h1', 201, { id: 1 });
    tick(24 * 60 * 60_000 - 1);
    expect((await store.start('lost', 'h1', 90_000)).state).toBe('replay');
    tick(1);
    expect(await store.start('lost', 'h1', 90_000)).toEqual({ state: 'first' });
  });

  it("a key belongs to its company, user, method and path; the body is compared in any key order (query included)", () => {
    const req = (user: { id: number; companyId: number }, method = 'POST', url = '/api/payments?x=1') => ({ method, url, originalUrl: url, headers: {}, user });
    const key = '0b5e7a0e-3f4c-4c51-9d0e-3c1f2a8e9b10';
    expect(idempotencyScope('e2e:', req({ id: 3, companyId: 1 }), key)).toBe(`e2e:idempotency:1:3:POST:/api/payments:${key}`);
    const scopes = new Set([req({ id: 3, companyId: 1 }), req({ id: 4, companyId: 1 }), req({ id: 3, companyId: 2 }), req({ id: 3, companyId: 1 }, 'PATCH', '/api/payments/9')].map((r) => idempotencyScope('', r, key)));
    expect(scopes.size).toBe(4);
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[1,{"c":2,"d":1}]}');
    expect(requestHash({ body: { a: 1, b: 2 } })).toBe(requestHash({ body: { b: 2, a: 1 }, query: {} }));
    expect(requestHash({ body: { a: 1 } })).not.toBe(requestHash({ body: { a: 2 } }));
    expect(requestHash({ body: { a: 1 }, query: { confirm: 'true' } })).not.toBe(requestHash({ body: { a: 1 } }));
  });
});
