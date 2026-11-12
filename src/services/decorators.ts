import { SetMetadata } from '@nestjs/common';
import type { Contract, EventsOf, Plane } from './contract.js';

export const IMPLEMENTS = 'framework:implements';
export const SUBSCRIBES = 'framework:subscribes';

/** Marks a provider as the handler of `contract`'s calls in this process. */
export function Implements(contract: Contract): ClassDecorator {
  return SetMetadata(IMPLEMENTS, contract);
}

export interface SubscriptionMeta {
  contract: Contract;
  event: string;
  /** Where the subscriber's data lives; `tenant` runs it in the event's company. */
  plane: Plane;
}

/**
 * Runs the method for every `event` of `contract`, once per event however many processes run it
 * (each subscriber method is its own consumer group). Delivery is at least once: the framework
 * skips an event this subscriber already handled, recorded in the same transaction as its work.
 */
export function Subscribe<C extends Contract>(contract: C, event: EventsOf<C>, options: { plane: Plane }): MethodDecorator {
  return (target, property) => {
    const list = (Reflect.getMetadata(SUBSCRIBES, target.constructor) as Array<SubscriptionMeta & { method: string }> | undefined) ?? [];
    Reflect.defineMetadata(SUBSCRIBES, [...list, { contract, event, plane: options.plane, method: String(property) }], target.constructor);
  };
}
