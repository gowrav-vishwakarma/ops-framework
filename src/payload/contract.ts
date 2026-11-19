import { RequestMethod, type INestApplication, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { defaultMetadataStorage } from 'class-transformer/cjs/storage.js';
import { getMetadataStorage, IS_IN, IS_NOT_IN, ValidationTypes } from 'class-validator';
import { validationMetadatasToSchemas } from 'class-validator-jsonschema';
import type { SchemaObject } from 'openapi3-ts';
import { CRUD_ROUTE, PAYLOAD_FALLBACK, type CrudRouteKind } from './route-meta.js';

/** One endpoint of the app as the contract lists it. */
export interface ContractRoute {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** OpenAPI style, prefix included: `/api/sales-invoices/{id}/actions/cancel`. */
  path: string;
  /** Who answers it: `SalesInvoiceController.create`, or `SalesInvoice action cancel` for an expanded CRUD route. */
  operation: string;
  body?: Type<object>;
  query?: Type<object>;
  /** Why the endpoint is not held to a class yet (the strictness gap): absent when it is, or takes nothing. */
  gap?: string;
}

const METHODS: Partial<Record<RequestMethod, ContractRoute['method']>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};
/** Nest's `RouteParamtypes`: `@Body()` and `@Query()`. */
const BODY = 3;
const QUERY = 4;
const PLAIN: unknown[] = [Object, String, Number, Boolean, Array, undefined];

interface CrudService {
  hasPayloadDto(op: string): boolean;
  payloadContract(): {
    label: string;
    dtos: Record<string, Type<object>>;
    actions: Array<{ name: string; label: string; kind: 'row' | 'bulk' | 'collection'; input?: Type<object> }>;
    lists: string[];
    views: string[];
    lookups: string[];
  };
}

const join = (...parts: string[]) =>
  `/${parts
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/')}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const first = (value: unknown): string => (Array.isArray(value) ? String(value[0] ?? '') : String(value ?? ''));

/**
 * Every route of the app with what it takes: the payload class of each body and query, a CRUD resource's generic routes
 * expanded into one entry per action (with its `dto.ts` or `input:`), and the endpoints that take a body no class holds
 * (`gap`). `skip` leaves routes out (`/api/qnatk/…`).
 */
export function collectRoutes(app: INestApplication, prefix = 'api', skip: (path: string) => boolean = () => false): ContractRoute[] {
  const scanner = new MetadataScanner();
  const routes: ContractRoute[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type<object> | null;
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!controller || !instance) continue;
      const base = first(Reflect.getMetadata(PATH_METADATA, controller));
      const proto = Object.getPrototypeOf(instance) as object;
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = (proto as Record<string, unknown>)[name] as object;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
        const verb = METHODS[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
        if (path === undefined || !verb) continue;
        const full = join(prefix, base, first(path));
        if (skip(full)) continue;
        const crud = Reflect.getMetadata(CRUD_ROUTE, proto, name) as CrudRouteKind | undefined;
        const service = instance.service as CrudService | undefined;
        if (crud && service && typeof service.payloadContract === 'function') {
          routes.push(...crudRoutes(crud, verb, full, proto, name, service));
          continue;
        }
        routes.push(plainRoute(verb, full, `${controller.name}.${name}`, controller, name));
      }
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** A hand-written route: its `@Body()` and `@Query()` classes; a body typed `Object` or picked by field is a gap. */
function plainRoute(method: ContractRoute['method'], path: string, operation: string, controller: Type<object>, name: string): ContractRoute {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {}) as Record<string, { index: number; data?: unknown; pipes?: unknown[] }>;
  const types = (Reflect.getMetadata('design:paramtypes', controller.prototype, name) ?? []) as unknown[];
  const route: ContractRoute = { method, path, operation };
  for (const [key, arg] of Object.entries(args)) {
    const kind = Number(key.split(':')[0]);
    const type = types[arg.index];
    if (kind === BODY) {
      if (arg.data !== undefined) route.gap = 'body fields picked one by one (@Body(name)): give the body a class';
      else if (arg.pipes?.length) route.gap = 'body checked by a pipe of its own, not held to a class';
      else if (PLAIN.includes(type)) route.gap = 'body typed Object (a Record, an interface or a literal type): give it a class';
      else route.body = type as Type<object>;
    }
    if (kind === QUERY && arg.data === undefined && !PLAIN.includes(type)) route.query = type as Type<object>;
  }
  return route;
}

/** A CRUD resource's generic route as one entry per operation. */
function crudRoutes(kind: CrudRouteKind, method: ContractRoute['method'], path: string, proto: object, name: string, service: CrudService): ContractRoute[] {
  const contract = service.payloadContract();
  const label = contract.label;
  switch (kind) {
    case 'create':
    case 'update': {
      const body = contract.dtos[kind] ?? contract.dtos.save ?? (Reflect.getMetadata(PAYLOAD_FALLBACK, proto, name) as Type<object> | undefined);
      return [{ method, path, operation: `${label} ${kind}`, ...(body ? { body } : { gap: 'no payload class' }) }];
    }
    case 'list': {
      const types = (Reflect.getMetadata('design:paramtypes', proto, name) ?? []) as Array<Type<object>>;
      return [{ method, path, operation: `${label} list${contract.lists.length ? ` (views: ${contract.lists.join(', ')})` : ''}`, query: contract.dtos.list ?? types[1] }];
    }
    case 'act':
    case 'actAll': {
      const own = contract.actions.filter((a) => (kind === 'act' ? a.kind === 'row' : a.kind !== 'row'));
      return own.map((a) => ({
        method,
        path: path.replace('{name}', a.name),
        operation: `${label} action ${a.name} (${a.label})`,
        ...(a.input ? { body: a.input } : { gap: 'action without a payload class (dto.ts)' }),
      }));
    }
    case 'view':
      return contract.views.map((v) => ({ method, path: path.replace('{name}', v), operation: `${label} view ${v}` }));
    case 'lookup':
      return contract.lookups.map((l) => ({ method, path: path.replace('{name}', l), operation: `${label} lookup ${l}` }));
  }
}

const NUMERIC_TEXT: SchemaObject = { type: 'string', pattern: '^-?\\d+(\\.\\d+)?$' };
const PRIMITIVE: Record<string, SchemaObject> = { text: { type: 'string' }, number: { type: 'number' }, boolean: { type: 'boolean' } };

/** The framework's own validators (JSON column shapes, `JsonField`). */
function frameworkValidator(name: string): SchemaObject | undefined {
  if (name === 'jsonNumber') return { type: 'number' };
  if (name === 'jsonNumeric') return { anyOf: [{ type: 'number' }, NUMERIC_TEXT] };
  const list = /^jsonListOf(.+)$/.exec(name);
  if (list) return { type: 'array', items: PRIMITIVE[list[1]!] ?? {} };
  return undefined;
}

/** `{ enum }` of the values, typed when they all share one JSON type. */
function enumOf(values: unknown[]): SchemaObject {
  const types = new Set(values.map((v) => (v === null ? 'null' : Number.isInteger(v) ? 'integer' : typeof v === 'number' ? 'number' : typeof v)));
  return { ...(types.size === 1 && !types.has('null') ? { type: [...types][0] as SchemaObject['type'] } : {}), enum: values };
}

export interface OpenApiOptions {
  title: string;
  version: string;
  /** JSON Schema for the app's own validators (`ValidateBy({ name })`), by name: `{ text: { type: 'string' } }`. */
  customValidators?: Record<string, SchemaObject>;
}

/**
 * OpenAPI 3.1 for the routes: each payload class (and every class nested in it) a schema under `components.schemas`,
 * named by its class name. Also returns what the document cannot say yet: the routes with a `gap`, two classes sharing
 * one name (one schema would hide the other: rename one) and custom validators without a schema.
 */
export function openApi(routes: ContractRoute[], options: OpenApiOptions) {
  const unconverted = new Set<string>();
  const schemas = validationMetadatasToSchemas({
    refPointerPrefix: '#/components/schemas/',
    classTransformerMetadataStorage: defaultMetadataStorage,
    additionalConverters: {
      // An allowed-values list as an enum (the library's own fails on values it cannot type, such as null).
      [IS_IN]: (meta) => enumOf(meta.constraints[0] as unknown[]),
      [IS_NOT_IN]: (meta) => ({ not: enumOf(meta.constraints[0] as unknown[]) }),
      [ValidationTypes.CUSTOM_VALIDATION]: (meta) => {
        const name = (meta as { name?: string }).name ?? meta.constraintCls?.name ?? 'custom';
        const schema = options.customValidators?.[name] ?? frameworkValidator(name);
        if (!schema) unconverted.add(name);
        return schema ?? {};
      },
    },
  });
  const ref = (type: Type<object>) => ({ $ref: `#/components/schemas/${type.name}` });
  const paths: Record<string, Record<string, object>> = {};
  for (const route of routes) {
    const params = [...route.path.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: m[1] === 'id' ? 'integer' : 'string' } }));
    const query = route.query ? Object.entries((schemas[route.query.name] as { properties?: Record<string, object> } | undefined)?.properties ?? {}).map(([name, schema]) => ({ name, in: 'query', schema })) : [];
    (paths[route.path] ??= {})[route.method] = {
      operationId: route.operation,
      ...(params.length || query.length ? { parameters: [...params, ...query] } : {}),
      ...(route.body ? { requestBody: { required: true, content: { 'application/json': { schema: ref(route.body) } } } } : {}),
      ...(route.gap ? { 'x-payload-gap': route.gap } : {}),
      responses: { default: { description: 'See the operation' } },
    };
  }
  // Every class with validation rules, by name: two classes of one name would share one schema.
  const byName = new Map<string, number>();
  const targets = (getMetadataStorage() as unknown as { validationMetadatas: Map<unknown, unknown> }).validationMetadatas.keys();
  for (const target of targets) if (typeof target === 'function') byName.set(target.name, (byName.get(target.name) ?? 0) + 1);
  const clashes = [...byName].filter(([, count]) => count > 1).map(([name]) => name).sort();
  return {
    document: { openapi: '3.1.0', info: { title: options.title, version: options.version }, paths, components: { schemas } },
    gaps: routes.filter((r) => r.gap).map((r) => ({ method: r.method.toUpperCase(), path: r.path, operation: r.operation, gap: r.gap! })),
    clashes,
    unconverted: [...unconverted].sort(),
  };
}
