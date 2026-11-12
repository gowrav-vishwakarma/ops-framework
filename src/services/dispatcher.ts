import { HttpException, Injectable, InternalServerErrorException, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QueryTypes, type Transaction } from 'sequelize';
import { fieldErrors, flattenValidationErrors } from '../errors.js';
import { runWithoutTenant } from '../tenancy/context.js';
import { sequelizeOf } from '../tenancy/guards.js';
import { ControlPlane } from '../tenancy/tenant-db.js';
import { TenantRunner } from '../tenancy/tenant-runner.js';
import { tenantTransaction } from '../tenancy/transaction.js';
import type { CallCtx, Contract, EventCtx, Plane } from './contract.js';
import { IMPLEMENTS, SUBSCRIBES, type SubscriptionMeta } from './decorators.js';
import { plain, type CallEnvelope, type EventEnvelope } from './envelope.js';
import { ControlInbox, TenantInbox } from './inbox.model.js';

type HandlerFn = (input: unknown, ctx: CallCtx | EventCtx) => Promise<unknown>;

/** One subscriber method in this process. `id` is its consumer group: unique per method. */
export interface Subscription extends SubscriptionMeta {
  id: string;
  run: HandlerFn;
}

/** Validates `raw` against a DTO class: field errors come back as a 400 like any request body. */
export async function validated<T extends object>(type: new () => T, raw: unknown): Promise<T> {
  const instance = plainToInstance(type, (raw ?? {}) as object);
  const errors = await validate(instance as object, { whitelist: true, forbidUnknownValues: false });
  if (errors.length) throw fieldErrors(flattenValidationErrors(errors));
  return instance;
}

/**
 * Runs calls and events for the handlers that live in this process, the same way for an in-process
 * caller and for one that came over HTTP or Redis: input validated, the handler in a transaction on
 * its plane (and in the company's tenant context for a tenant handler), the idempotency or event
 * record committed with the handler's work, the result as plain JSON. A non-HTTP error becomes a
 * plain 500 so internals never cross to another service.
 */
@Injectable()
export class ServiceDispatcher {
  private readonly logger = new Logger('Services');
  private handlers: Map<string, { contract: Contract; instance: Record<string, HandlerFn> }> | null = null;
  private subs: Subscription[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly control: ControlPlane,
    private readonly runner: TenantRunner,
  ) {}

  /** Contracts answered in this process. */
  hasLocal(contract: string): boolean {
    return this.discover().has(contract);
  }

  subscriptions(): Subscription[] {
    this.discover();
    return this.subs;
  }

  async call(envelope: CallEnvelope): Promise<unknown> {
    const local = this.discover().get(envelope.contract);
    if (!local) throw new NotFoundException(`No handler for contract "${envelope.contract}"`);
    const def = local.contract.calls[envelope.call];
    const method = local.instance[envelope.call];
    if (!def || typeof method !== 'function') throw new NotFoundException(`Unknown call "${envelope.contract}.${envelope.call}"`);
    const name = `${envelope.contract}.${envelope.call}`;
    return this.guarded(name, async () => {
      const input = await validated(def.input as new () => object, envelope.input);
      const key = def.kind === 'command' ? envelope.key : undefined;
      return this.inPlane(local.contract.plane, envelope.companyId, name, key, (t) =>
        method.call(local.instance, input, { contract: envelope.contract, call: envelope.call, companyId: envelope.companyId, key, caller: envelope.caller ?? {}, t }),
      );
    });
  }

  /** Delivers one event to one subscriber. Throws when it failed, so the transport retries it. */
  async deliver(subscription: Subscription, envelope: EventEnvelope): Promise<void> {
    await this.guarded(subscription.id, async () => {
      const payload = await validated(subscription.contract.events[envelope.event]?.payload as new () => object, envelope.payload);
      await this.inPlane(subscription.plane, envelope.companyId, subscription.id, envelope.id, (t) =>
        subscription.run(payload, { contract: envelope.contract, event: envelope.event, eventId: envelope.id, companyId: envelope.companyId, caller: envelope.caller ?? {}, t }),
      );
    });
  }

  private async guarded<T>(name: string, work: () => Promise<T>): Promise<T> {
    try {
      return plain(await work());
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      throw new InternalServerErrorException(`${name} failed`);
    }
  }

  /**
   * The handler's transaction. With a key: one runner per key at a time (advisory lock), a stored
   * result is returned instead of running again, and a new result is stored in the same transaction.
   */
  private inPlane(plane: Plane, companyId: number | undefined, handler: string, key: string | undefined, run: (t: Transaction) => Promise<unknown>): Promise<unknown> {
    const once = async (t: Transaction, inbox: typeof ControlInbox | typeof TenantInbox) => {
      if (!key) return run(t);
      await sequelizeOf(t).query('SELECT pg_advisory_xact_lock(hashtext(:lock))', { replacements: { lock: `${companyId ?? 0}:${handler}:${key}` }, type: QueryTypes.SELECT, transaction: t });
      const done = await (inbox as typeof ControlInbox).findOne({ where: { handler, key }, transaction: t });
      if (done) return done.result;
      const result = plain(await run(t));
      await (inbox as typeof ControlInbox).create({ handler, key, result: result ?? null } as never, { transaction: t });
      return result;
    };
    if (plane === 'control') return runWithoutTenant(() => this.control.tx((t) => once(t, ControlInbox)));
    if (!companyId) throw new BadRequestException(`${handler} works on a company: call it with a company`);
    return this.runner.run({ companyId }, () => tenantTransaction((t) => once(t, TenantInbox)));
  }

  private discover() {
    if (this.handlers) return this.handlers;
    const handlers = new Map<string, { contract: Contract; instance: Record<string, HandlerFn> }>();
    const subs: Subscription[] = [];
    for (const wrapper of this.discovery.getProviders()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype || typeof metatype !== 'function') continue;
      const contract = Reflect.getMetadata(IMPLEMENTS, metatype) as Contract | undefined;
      if (contract) {
        if (handlers.has(contract.name)) throw new Error(`Contract "${contract.name}" is implemented twice`);
        for (const call of Object.keys(contract.calls)) {
          if (typeof (instance as Record<string, unknown>)[call] !== 'function') throw new Error(`${metatype.name} implements "${contract.name}" but has no method ${call}()`);
        }
        handlers.set(contract.name, { contract, instance: instance as Record<string, HandlerFn> });
      }
      const listed = (Reflect.getMetadata(SUBSCRIBES, metatype) as Array<SubscriptionMeta & { method: string }> | undefined) ?? [];
      for (const meta of listed) {
        if (!meta.contract.events[meta.event]) throw new Error(`${metatype.name}.${meta.method} subscribes to unknown event "${meta.contract.name}.${meta.event}"`);
        const fn = (instance as Record<string, HandlerFn>)[meta.method] as HandlerFn;
        subs.push({ ...meta, id: `${metatype.name}.${meta.method}`, run: (payload, ctx) => fn.call(instance, payload, ctx) });
      }
    }
    this.handlers = handlers;
    this.subs = subs;
    if (handlers.size || subs.length) this.logger.log(`Answering ${[...handlers.keys()].join(', ') || 'no contracts'}; ${subs.length} event subscriber(s)`);
    return handlers;
  }
}
