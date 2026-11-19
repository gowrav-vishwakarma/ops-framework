import type { ArgumentMetadata, PipeTransform, Type } from '@nestjs/common';
import type { FieldErrors } from '../errors.js';
import { checkPayload, type PayloadStrictness } from './check-payload.js';

const PLAIN: unknown[] = [Object, String, Number, Boolean, Array];

/**
 * The app's global pipe for request bodies and queries typed with a DTO class (`@Body() body: ReceiptSaveDto`): each is
 * held to its class as `checkPayload` does, in the deployment's strictness. Parameters typed `Object` (a `Record`, an
 * interface) and other primitives pass untouched (a named param or query typed number / boolean is converted, as
 * Nest's ValidationPipe does): an operation's `dto.ts` covers the framework's own routes.
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
    // A named param or query typed number / boolean is converted, as Nest's ValidationPipe (transform) does.
    if (data && (type === 'param' || type === 'query')) {
      if (metatype === Number) return value === undefined ? value : +(value as string);
      if (metatype === Boolean) return value === undefined ? value : value === true || value === 'true';
      return value;
    }
    if ((type !== 'body' && type !== 'query') || data || !metatype || PLAIN.includes(metatype)) return value;
    // A query class whose other keys are named parameters checked elsewhere (a lookup's): those are not unknown fields.
    const mode = (metatype as { namedParams?: boolean }).namedParams ? 'off' : this.mode;
    return checkPayload(metatype as Type<object>, value ?? {}, { endpoint: `${type} ${metatype.name}`, mode, refuse: this.refuse });
  }
}
