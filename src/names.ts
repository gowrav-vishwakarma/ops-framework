/**
 * Side-effect-free entry for naming: loads no model. Import it in the module that runs first
 * (`import './framework-names.js'` at the top of `main.ts`, tools and test setup).
 */
export { defineNames, NAMES, type FrameworkNames } from './naming.js';
export { definePartition, PARTITION, type PartitionConfig } from './tenancy/partition.js';
