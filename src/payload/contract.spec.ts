import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, ValidateBy, ValidateNested } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { Slot } from '../request/slot.js';
import { collectRoutes, openApi } from './contract.js';

class ContractLine {
  @IsInt() productId!: number;
}
class ContractSave {
  @IsString() number!: string;
  @ValidateBy({ name: 'shortCode', validator: { validate: (v) => typeof v === 'string' } }) code!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => ContractLine) lines!: ContractLine[];
}
class ContractFilter {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsIn([null, 'open', 'closed']) state?: string | null;
}

@Controller('things')
class ThingsController {
  @Get()
  list(@Query() _query: ContractFilter) {
    return [];
  }
  @Post()
  create(@Body() _body: ContractSave) {
    return {};
  }
  @Patch(':id')
  update(@Param('id') _id: string, @Body() _body: Record<string, unknown>) {
    return {};
  }
  @Post(':id/actions/cancel')
  cancel(@Param('id') _id: string, @Body('reason') _reason: string) {
    return {};
  }
  @Post('report')
  @Slot('medium', { readOnly: true })
  report(@Body() _body: ContractFilter) {
    return {};
  }
}

describe('the contract: every route with what it takes', async () => {
  const module = await Test.createTestingModule({ controllers: [ThingsController] }).compile();
  const app = module.createNestApplication();
  await app.init();
  const routes = collectRoutes(app);

  it('lists each route with its body and query classes; a body no class holds is a gap', () => {
    expect(routes.map((r) => ({ method: r.method, path: r.path, body: r.body?.name, query: r.query?.name, gap: r.gap }))).toEqual([
      { method: 'get', path: '/api/things', query: 'ContractFilter', body: undefined, gap: undefined },
      { method: 'post', path: '/api/things', body: 'ContractSave', query: undefined, gap: undefined },
      { method: 'patch', path: '/api/things/{id}', body: undefined, query: undefined, gap: 'body typed Object (a Record, an interface or a literal type): give it a class' },
      { method: 'post', path: '/api/things/{id}/actions/cancel', body: undefined, query: undefined, gap: 'body fields picked one by one (@Body(name)): give the body a class' },
      { method: 'post', path: '/api/things/report', body: 'ContractFilter', query: undefined, gap: undefined },
    ]);
  });

  it('what each route does: a GET reads, any other method writes unless @Slot says it only reads; its slot (fast by default)', () => {
    expect(routes.map((r) => `${r.method} ${r.path} ${r.readOnly ? 'read' : 'write'} ${r.slot}`)).toEqual([
      'get /api/things read fast',
      'post /api/things write fast',
      'patch /api/things/{id} write fast',
      'post /api/things/{id}/actions/cancel write fast',
      'post /api/things/report read medium',
    ]);
    const { document } = openApi(routes, { title: 'Things', version: '1', customValidators: { shortCode: { type: 'string' } } });
    const paths = document.paths as Record<string, Record<string, { parameters?: unknown[]; 'x-slot'?: string }>>;
    const key = { $ref: '#/components/parameters/IdempotencyKey' };
    // Writes take the idempotency key; reads (and a POST report that only reads) do not.
    expect(paths['/api/things']!.post!.parameters).toEqual([key]);
    expect(paths['/api/things']!.get!.parameters).not.toContainEqual(key);
    expect(paths['/api/things/report']!.post!.parameters).toBeUndefined();
    expect(paths['/api/things/report']!.post!['x-slot']).toBe('medium');
    expect(paths['/api/things']!.post!['x-slot']).toBeUndefined();
    expect((document.components as { parameters: Record<string, { name: string; in: string }> }).parameters.IdempotencyKey).toMatchObject({ name: 'Idempotency-Key', in: 'header' });
  });

  it('OpenAPI 3.1: bodies as schemas (nested classes included), queries as parameters, gaps marked', () => {
    const { document, gaps, unconverted } = openApi(routes, { title: 'Things', version: '1', customValidators: {} });
    const paths = document.paths as Record<string, Record<string, { requestBody?: unknown; parameters?: Array<{ name: string; in: string }>; 'x-payload-gap'?: string }>>;
    expect(paths['/api/things']!.post!.requestBody).toEqual({ required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ContractSave' } } } });
    expect(paths['/api/things']!.get!.parameters).toEqual([
      { name: 'search', in: 'query', schema: { type: 'string' } },
      // An allowed-values list with a null: an enum without a single type.
      { name: 'state', in: 'query', schema: { enum: [null, 'open', 'closed'] } },
    ]);
    expect(paths['/api/things/{id}']!.patch!.parameters).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }, { $ref: '#/components/parameters/IdempotencyKey' }]);
    const schemas = document.components.schemas as Record<string, { properties: Record<string, unknown>; required?: string[] }>;
    expect(schemas.ContractSave!.properties.lines).toEqual({ type: 'array', items: { $ref: '#/components/schemas/ContractLine' } });
    expect(schemas.ContractLine!.properties.productId).toEqual({ type: 'integer' });
    expect(gaps.map((g) => `${g.method} ${g.path}`)).toEqual(['PATCH /api/things/{id}', 'POST /api/things/{id}/actions/cancel']);
    // A custom validator without a schema is listed, so the app adds it.
    expect(unconverted).toEqual(['shortCode']);
    expect(openApi(routes, { title: 'Things', version: '1', customValidators: { shortCode: { type: 'string' } } }).unconverted).toEqual([]);
  });

  it('two classes sharing a name are reported (one schema would hide the other)', () => {
    const make = () => {
      class ContractTwin {
        @IsString() a!: string;
      }
      return ContractTwin;
    };
    make();
    make();
    expect(openApi(routes, { title: 'Things', version: '1' }).clashes).toContain('ContractTwin');
  });
});
