import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/** Paging, free-text search and sort shared by every list endpoint. */
export class ListQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  /** Only rows in this state, for entities with a `status` column (lookups ask for `active`). */
  @IsOptional()
  @IsString()
  status?: string;

  /** JSON object of column key to text, from the desk grid filter row. Keys may be `alias.field`. */
  @IsOptional()
  @IsString()
  filters?: string;

  /** Column key; `alias.field` sorts on an included model. */
  @IsOptional()
  @IsString()
  sort?: string;

  /** A named list defined by the entity's `ops/list-<view>/` folder. */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'Unknown list view' })
  view?: string;

  @IsOptional()
  @IsIn(['ASC', 'DESC', 'asc', 'desc'])
  dir?: string;

  /** `1`: add `_actions` (what the caller can run on each row, and why not) to every row. */
  @IsOptional()
  @IsIn(['0', '1'])
  actions?: string;

  /** `1`: only soft-deleted rows. Needs the resource's `restore` permission. */
  @IsOptional()
  @IsIn(['0', '1'])
  deleted?: string;
}

export interface Paged<T> {
  rows: T[];
  count: number;
}
