import type { ArgumentMetadata, PipeTransform, Type } from '@nestjs/common';
import type { FieldErrors } from '../errors.js';
import { checkPayload, type PayloadStrictness } from './check-payload.js';

const PLAIN: unknown[] = [Object, String, Number, Boolean, Array];

/**
 * The app's global pipe for request bodies and queries typed with a DTO class (`@Body() body: ReceiptSaveDto`): each is
 * held to its class as `checkPayload` does, in the deployment's strictness. Parameters typed `Object` (a `Record`, an
 * interface), primitives and route params pass untouched: an operation's `dto.ts` covers the framework's own routes.
 *
 *   app.useGlobalPipes(new PayloadPipe('warn', (errors) => fieldErrors(errors)));
 */
export class PayloadPipe implements PipeTransform {
  constructor(
    private readonly mode: PayloadStrictness,
    private readonly refuse?: (errors: FieldErrors) => Error,
  ) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const { type, metatype, data } = metadata;
    if ((type !== 'body' && type !== 'query') || data || !metatype || PLAIN.includes(metatype)) return value;
    return checkPayload(metatype as Type<object>, value ?? {}, { endpoint: `${type} ${metatype.name}`, mode: this.mode, refuse: this.refuse });
  }
}
