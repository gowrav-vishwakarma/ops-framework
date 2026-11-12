/**
 * Wrap association property types in `Rel<T>`. Under ESM, a plain class type makes
 * `emitDecoratorMetadata` read the other model while circular imports are still
 * initialising; an alias is emitted as `Object` instead.
 */
export type Rel<T> = T;
