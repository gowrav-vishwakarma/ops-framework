/** class-transformer's metadata store (its `@Type` records): the contract reads nested classes from it. */
declare module 'class-transformer/cjs/storage.js' {
  import type { MetadataStorage } from 'class-transformer/types/MetadataStorage.js';
  export const defaultMetadataStorage: MetadataStorage;
}
