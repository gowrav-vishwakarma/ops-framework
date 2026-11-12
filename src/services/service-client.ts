import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClsServiceManager } from 'nestjs-cls';
import { currentTenant } from '../tenancy/context.js';
import type { CommandsOf, Contract, InputOf, OutputOf, QueriesOf } from './contract.js';
import { ServiceDispatcher } from './dispatcher.js';
import type { CallEnvelope } from './envelope.js';
import { RemoteCalls } from './remote-calls.js';

export interface CallOptions {
  /** Idempotency key of a command: the receiver runs it once per key and returns the first result after. */
  key?: string;
  /** The company the call is for. Defaults to the caller's own company (its tenant context). */
  companyId?: number;
  timeoutMs?: number;
}

/** A typed client of one contract. */
export interface ContractClient<C extends Contract> {
  command<K extends CommandsOf<C>>(name: K, input: InputOf<C['calls'][K]>, options?: CallOptions): Promise<OutputOf<C['calls'][K]>>;
  query<K extends QueriesOf<C>>(name: K, input: InputOf<C['calls'][K]>, options?: CallOptions): Promise<OutputOf<C['calls'][K]>>;
}

function requestId(): string | undefined {
  try {
    const cls = ClsServiceManager.getClsService();
    return cls.isActive() ? cls.getId() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Calls another service through its contract. In process when this process answers the contract
 * (one image running everything: dev, on-prem), over HTTP otherwise. Same validation, transaction,
 * idempotency and JSON results either way.
 */
@Injectable()
export class ServiceClient {
  constructor(
    private readonly dispatcher: ServiceDispatcher,
    private readonly remote: RemoteCalls,
  ) {}

  for<C extends Contract>(contract: C): ContractClient<C> {
    const send = (name: string, input: unknown, options: CallOptions = {}) => {
      const tenant = currentTenant();
      const envelope: CallEnvelope = {
        id: randomUUID(),
        contract: contract.name,
        call: name,
        input,
        key: options.key,
        companyId: options.companyId ?? (tenant?.ref.companyId || undefined),
        caller: { companyId: tenant?.ref.companyId || undefined, requestId: requestId() },
      };
      if (this.dispatcher.hasLocal(contract.name)) return this.dispatcher.call(envelope);
      const retryable = contract.calls[name]?.kind === 'query' || !!options.key;
      return this.remote.call(envelope, retryable, options.timeoutMs);
    };
    return { command: send, query: send } as ContractClient<C>;
  }
}
