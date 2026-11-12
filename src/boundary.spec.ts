import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };

const SRC = dirname(fileURLToPath(import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((match) => match[1] as string);

/** `@nestjs/common/x` -> `@nestjs/common`, `sequelize/types` -> `sequelize`. */
const packageOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);

describe('framework package boundary', () => {
  it('relative imports never leave src', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      for (const spec of importsOf(file).filter((s) => s.startsWith('.'))) {
        const target = relative(SRC, resolve(dirname(file), spec));
        if (target.startsWith('..') && !(file.endsWith('.spec.ts') && target === '../package.json')) offenders.push(`${relative(SRC, file)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runtime code imports only node built-ins and declared peer dependencies', () => {
    const allowed = new Set(Object.keys(pkg.peerDependencies));
    const offenders: string[] = [];
    for (const file of sources(SRC).filter((f) => !f.endsWith('.spec.ts') && !f.includes('/testing/'))) {
      for (const spec of importsOf(file).filter((s) => !s.startsWith('.') && !s.startsWith('node:'))) {
        if (!allowed.has(packageOf(spec)) && packageOf(spec) !== 'express') offenders.push(`${relative(SRC, file)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
