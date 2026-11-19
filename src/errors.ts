import { BadRequestException, UnprocessableEntityException, type ValidationError } from '@nestjs/common';

/** Field errors in the `{ errors: { field: [message] } }` shape the desk forms read. */
export type FieldErrors = Record<string, string[]>;

export function fieldErrors(errors: FieldErrors, message = 'Please fix the highlighted fields'): UnprocessableEntityException {
  return new UnprocessableEntityException({ message, errors });
}

/**
 * A request malformed against its contract (an unknown field, a wrong type, a missing required field, a value outside
 * the allowed list): 400 with the same `{ message, errors }` shape. `fieldErrors` (422) stays for a well-formed request
 * a business rule refuses.
 */
export function payloadErrors(errors: FieldErrors, message = 'Please fix the highlighted fields'): BadRequestException {
  return new BadRequestException({ message, errors });
}

export function fieldError(field: string, message: string): UnprocessableEntityException {
  return fieldErrors({ [field]: [message] }, message);
}

/** class-validator tree to dotted paths: `documents.0.expiryDate`. */
export function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldErrors {
  const out: FieldErrors = {};
  for (const error of errors) {
    const path = parent ? `${parent}.${error.property}` : error.property;
    if (error.constraints) out[path] = Object.values(error.constraints);
    if (error.children?.length) Object.assign(out, flattenValidationErrors(error.children, path));
  }
  return out;
}
