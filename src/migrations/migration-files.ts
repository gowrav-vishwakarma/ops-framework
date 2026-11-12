import { Inject, Injectable } from '@nestjs/common';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import type { Migration, MigrationFile, MigrationTarget } from './migration.js';

const FILE = /^(\d{14}-[a-z0-9]+(?:-[a-z0-9]+)*)\.(?:js|ts)$/;

/** Lists a folder's migrations in name (time) order. A bad name fails loudly instead of being skipped. */
export function listMigrations(folder: string | undefined): MigrationFile[] {
  if (!folder || !existsSync(folder)) return [];
  const files: MigrationFile[] = [];
  for (const entry of readdirSync(folder).sort()) {
    if (entry.endsWith('.d.ts') || entry.endsWith('.map') || entry.startsWith('.')) continue;
    const match = FILE.exec(entry);
    if (!match) throw new Error(`Bad migration file name ${join(folder, entry)}: expected YYYYMMDDHHMMSS-name.ts`);
    files.push({ name: match[1] as string, path: join(folder, entry) });
  }
  const names = files.map((file) => file.name);
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice) throw new Error(`Migration ${twice} exists twice (.ts and .js?) in ${folder}`);
  return files;
}

export async function loadMigration(file: MigrationFile): Promise<Migration> {
  const exported = ((await import(pathToFileURL(file.path).href)) as { default?: Migration }).default;
  if (!exported || typeof exported.up !== 'function') throw new Error(`${file.path} must \`export default migration({ up })\``);
  return exported;
}

/** The app's migration folders (`FrameworkOptions.migrations`). */
@Injectable()
export class MigrationFiles {
  constructor(@Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions) {}

  list(target: MigrationTarget): MigrationFile[] {
    return listMigrations(this.options.migrations?.[target]);
  }
}
