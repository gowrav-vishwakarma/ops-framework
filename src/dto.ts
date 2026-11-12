import { applyDecorators } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** A required id of another row. */
export const Id = () => applyDecorators(Type(() => Number), IsInt(), Min(1));
/** An id that may be left out or sent as null. */
export const OptId = () => applyDecorators(IsOptional(), Type(() => Number), IsInt(), Min(1));
/** Rupees with up to two decimals. */
export const Rupees = () => applyDecorators(Type(() => Number), IsNumber({ maxDecimalPlaces: 2 }), Min(0), Max(999_999_999_999));
export const OptRupees = () => applyDecorators(IsOptional(), Rupees());
/** Weight, litres or km with up to three decimals. */
export const Amount = () => applyDecorators(Type(() => Number), IsNumber({ maxDecimalPlaces: 3 }), Min(0), Max(999_999_999_999));
export const OptAmount = () => applyDecorators(IsOptional(), Amount());
/** `YYYY-MM-DD` or a full ISO timestamp. */
export const Iso = () => applyDecorators(IsISO8601());
export const OptIso = () => applyDecorators(IsOptional(), IsISO8601());
export const Text = (max = 120) => applyDecorators(IsString(), MaxLength(max));
export const OptText = (max = 120) => applyDecorators(IsOptional(), IsString(), MaxLength(max));
export const OneOf = (values: readonly string[]) => applyDecorators(IsIn(values as string[]));
export const OptOneOf = (values: readonly string[]) => applyDecorators(IsOptional(), IsIn(values as string[]));
