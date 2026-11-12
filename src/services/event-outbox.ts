import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Op, type Transaction } from 'sequelize';
import { ClsServiceManager } from 'nestjs-cls';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { currentTenant, runWithoutTenant } from '../tenancy/context.js';
import { txMark } from '../tenancy/guards.js';
import { PlacementResolver } from '../tenancy/placement.js';
import { ControlPlane } from '../tenancy/tenant-db.js';
import { TenantRunner } from '../tenancy/tenant-runner.js';
import { tenantTransaction } from '../tenancy/transaction.js';
import type { Contract, EventsOf, PayloadOf } from './contract.js';
import { ServiceDispatcher, validated } from './dispatcher.js';
import type { EventEnvelope } from './envelope.js';
import { EventTransport } from './event-transport.js';
import { ControlInbox, TenantInbox } from './inbox.model.js';
import { ControlOutbox, TenantOutbox } from './outbox.model.js';

type OutboxRow = ControlOutbox | TenantOutbox;

/** The outermost transaction of `t` (a savepoint's parent chain). */
function rootOf(t: Transaction): Transaction {
  let top = t;
  for (let up = (top as unknown as { parent?: Transaction }).parent; up; up = (top as unknown as { parent?: Transaction }).parent) top = up;
  return top;
}

function requestId(): string | undefined {
  try {
    const cls = ClsServiceManager.getClsService();
    return cls.isActive() ? cls.getId() : undefined;
  } catch {
    return undefined;
  }
}

/** Keep published events and handled-call records this long. */
const KEEP_MS = 7 * 86_400_000;
/** The sweeper leaves fresher rows to the process that wrote them. */
const SWEEP_AFTER_MS = 10_000;

/**
 * Durable events. `emit` writes the event into the outbox of the transaction's database (the
 * control plane or the tenant's schema) in that transaction, and publishes it after commit. If
 * the process dies in between, the sweeper (every `services.sweepMs`, one process per schema at a
 * time) publishes it. Nothing is published for a rolled-back change.
 */
@Injectable()
export class EventOutbox implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Events');
  private sweeper: NodeJS.Timeout | null = null;
  private sweeping = false;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly transport: EventTransport,
    private readonly dispatcher: ServiceDispatcher,
    private readonly control: ControlPlane,
    private readonly runner: TenantRunner,
    private readonly placements: PlacementResolver,
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.transport.start(this.dispatcher.subscriptions(), (subscription, envelope) => this.dispatcher.deliver(subscription, envelope));
    const every = this.options.services?.sweepMs ?? 15_000;
    if (every > 0) {
      this.sweeper = setInterval(() => {
        if (!this.sweeping) void this.sweep();
      }, every);
      this.sweeper.unref();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await this.transport.stop();
  }

  /**
   * Records `event` in `t` (a control-plane or tenant transaction) and publishes it after commit.
   * A tenant event carries the company of the tenant context.
   */
  async emit<C extends Contract, E extends EventsOf<C>>(t: Transaction, contract: C, event: E, payload: PayloadOf<C['events'][E]>): Promise<string> {
    const def = contract.events[event];
    if (!def) throw new Error(`Unknown event "${contract.name}.${event}"`);
    const valid = await validated(def.payload as new () => object, payload);
    const plane = txMark(t)?.kind;
    if (!plane) throw new Error('emit() needs a control-plane or tenant transaction (ControlPlane.tx, TenantDb.tx, c.t)');
    const tenant = currentTenant();
    const companyId = plane === 'tenant' ? tenant?.ref.companyId : ((payload as { companyId?: number }).companyId ?? undefined);
    const row = {
      eventId: randomUUID(),
      contract: contract.name,
      event,
      payload: JSON.parse(JSON.stringify(valid)) as unknown,
      caller: { companyId: tenant?.ref.companyId || undefined, requestId: requestId() },
      companyId: companyId ?? null,
    };
    const model = plane === 'control' ? ControlOutbox : TenantOutbox;
    const created = (await (model as typeof ControlOutbox).create(row as never, { transaction: t })) as OutboxRow;
    rootOf(t).afterCommit(() => {
      const flush = (plane === 'control' ? runWithoutTenant(() => this.flushControl([created.id as number])) : this.flushTenant([created.id as number]))
        .catch((error: unknown) => this.logger.warn(`Event ${row.eventId} not published yet (the sweeper retries): ${String(error)}`))
        .finally(() => this.inFlight.delete(flush));
      this.inFlight.add(flush);
    });
    return row.eventId;
  }

  /**
   * Waits for the publishes this process started after commits, then publishes whatever is left
   * everywhere, however fresh. For seeds, tools and tests that must see events delivered before
   * they go on; never needed in request code.
   */
  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.all(this.inFlight);
    await this.sweep({ all: true });
  }

  /** Publishes unpublished control-plane events (`ids`, or all old enough when sweeping). */
  async flushControl(ids?: number[], all = false): Promise<number> {
    return this.control.tx((t) => this.flushIn(t, ControlOutbox, ids, all));
  }

  /** Same, in the current tenant context's schema. */
  async flushTenant(ids?: number[], all = false): Promise<number> {
    return tenantTransaction((t) => this.flushIn(t, TenantOutbox, ids, all));
  }

  private async flushIn(t: Transaction, model: typeof ControlOutbox | typeof TenantOutbox, ids?: number[], all = false): Promise<number> {
    const where = ids
      ? { id: { [Op.in]: ids }, publishedAt: null }
      : all
        ? { publishedAt: null }
        : { publishedAt: null, createdAt: { [Op.lt]: new Date(Date.now() - SWEEP_AFTER_MS) } };
    // SKIP LOCKED: two sweepers (or a sweeper and the writer) never publish the same row at once.
    const rows = (await (model as typeof ControlOutbox).findAll({ where: where as never, order: [['id', 'ASC']], limit: 200, lock: t.LOCK.UPDATE, skipLocked: true, transaction: t })) as OutboxRow[];
    let published = 0;
    for (const row of rows) {
      try {
        await this.transport.publish(this.envelopeOf(row));
        await row.update({ publishedAt: new Date(), attempts: row.attempts + 1 } as never, { transaction: t });
        published++;
      } catch (error) {
        await row.update({ attempts: row.attempts + 1 } as never, { transaction: t });
        this.logger.warn(`Event ${row.contract}.${row.event} ${row.eventId} attempt ${row.attempts + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return published;
  }

  private envelopeOf(row: OutboxRow): EventEnvelope {
    return {
      id: row.eventId,
      contract: row.contract,
      event: row.event,
      payload: row.payload,
      companyId: (row.get('companyId') as number | null) ?? undefined,
      caller: row.caller,
      at: (row.get('createdAt') as Date).toISOString(),
    };
  }

  /** One pass over the control plane and every tenant place: publish leftovers, drop old records. `all`: also fresh ones. */
  async sweep(options: { all?: boolean } = {}): Promise<void> {
    while (this.sweeping) await new Promise((resolve) => setTimeout(resolve, 20));
    this.sweeping = true;
    try {
      await runWithoutTenant(async () => {
        await this.flushControl(undefined, options.all);
        await this.control.tx(async (t) => {
          await ControlOutbox.destroy({ where: { publishedAt: { [Op.lt]: new Date(Date.now() - KEEP_MS) } }, transaction: t });
          await ControlInbox.destroy({ where: { createdAt: { [Op.lt]: new Date(Date.now() - KEEP_MS) } }, transaction: t });
        });
      });
      const seen = new Set<string>();
      for (const route of await this.placements.activeRoutes()) {
        const place = `${route.dbKey}.${route.schema}`;
        if (seen.has(place)) continue;
        seen.add(place);
        // Company 0: no partition filter, so one pass covers every company in the schema.
        await this.runner
          .run({ companyId: 0 }, async () => {
            await this.flushTenant(undefined, options.all);
            await tenantTransaction(async (t) => {
              await TenantOutbox.destroy({ where: { publishedAt: { [Op.lt]: new Date(Date.now() - KEEP_MS) } }, transaction: t });
              await TenantInbox.destroy({ where: { createdAt: { [Op.lt]: new Date(Date.now() - KEEP_MS) } }, transaction: t });
            });
          }, { placement: { dbKey: route.dbKey, schema: route.schema, epoch: route.epoch } })
          .catch((error: unknown) => this.logger.warn(`Sweep of ${place} failed: ${String(error)}`));
      }
    } catch (error) {
      this.logger.warn(`Sweep failed: ${String(error)}`);
    } finally {
      this.sweeping = false;
    }
  }
}
