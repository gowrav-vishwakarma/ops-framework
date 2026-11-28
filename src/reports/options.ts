import type { ModuleMetadata, Type } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import type { Rdl2PivotView, Rdl2Report, Rdl2StageBase } from './language.js';

/**
 * `ReportsModule.register(config)`: what a project tells the report engine. Everything is optional except the store and
 * the user. Guide: `docs/reports.md`.
 */
export interface ReportsConfig {
  /** Where saved reports and pivots are kept (the project's table). */
  store: Type<ReportStore>;
  /** Who is running, from the request. */
  user: Type<ReportUserSource>;
  /** The values of `rowScope` a user may read; needed when `rowScope` is set. */
  rowScopeSource?: Type<ReportRowScopeSource>;
  /** Modules the project's classes need (`SequelizeModule.forFeature([...])`). */
  imports?: ModuleMetadata['imports'];
  /** What the model catalog cannot read from the models. */
  catalog?: ReportCatalogOptions;
  /** A second narrowing after the company (a user's branches), with its fields and paths. Off when unset. */
  rowScope?: ReportRowScopeOptions;
  /** Reports shipped in code, run by name before saved ones (system reports). */
  shipped?: () => readonly Rdl2Report<Rdl2StageBase>[];
  /** Run limits. Out-of-range values fall back to the defaults. */
  limits?: Partial<ReportLimits>;
  /** Routes: `POST /<path>/<action>` (default `reports`), and each action's name (default its own). */
  routes?: { path?: string; actions?: Partial<Record<ReportAction, string>> };
  /** Permission for every route but the catalog (`[resource, action]`); default none beyond a signed-in user. */
  permission?: [string, string];
  /** Words for refusals that name the product (`System reports stay with <product>`). Default `the system`. */
  product?: string;
}

export type ReportAction = 'catalog' | 'list' | 'run' | 'lookup' | 'save' | 'delete';

export interface ReportLimits {
  /** Longest a report query may run, ms. Default 30000, 1000 to 300000. */
  timeoutMs: number;
  /** Postgres sort memory for one report (`16MB`), raised only inside its transaction; null keeps the server's. */
  workMem: string | null;
  /** Report runs at once in this process; more wait their turn. Default 3, 1 to 20. */
  maxRuns: number;
}

export interface ReportCatalogOptions {
  /** Models a report may read (by name); default every model on the connection. */
  include?: (model: string) => boolean;
  /** Models never readable: names or patterns (credentials, logs, chat). */
  hiddenModels?: ReadonlyArray<string | RegExp>;
  /** Field name patterns never readable, beyond the framework's (`password`, `token`, `secret`…). */
  hiddenFields?: readonly RegExp[];
  /** Labels where the model name reads poorly. */
  labels?: Readonly<Record<string, string>>;
  /** Words written in capitals in labels (`gst`, `hsn`). */
  acronyms?: readonly string[];
  /** Flag fields true on a deleted row (`isDelete`); a paranoid model's `deletedAt` is found by itself. */
  softDeleteFlags?: readonly string[];
}

export interface ReportRowScopeOptions {
  /** The scope field on models (`branchId`). */
  field: string;
  /** Models never scoped, even when they hold the field (masters every scope shares). */
  free?: readonly string[];
  /** A model without the field: the belongs-to path to one that has it. Items named after their header are found alone. */
  paths?: Readonly<Record<string, string>>;
  /**
   * Models scoped by several fields, any of them enough: a transfer `['fromBranchId', 'toBranchId']` is read by a user
   * of either branch. Their lines reach them through `paths` (or by name) as for one field.
   */
  fields?: Readonly<Record<string, readonly string[]>>;
  /**
   * A model a scoped user reads that is not scoped (not `free`, no field, no path): `read` (default) reads it whole;
   * `refuse` refuses the report, so a model left out of the mapping fails closed.
   */
  unscoped?: 'read' | 'refuse';
}

/** The signed-in user as a report needs them. A project's `ReportUserSource` adds what its hooks read. */
export interface ReportUser {
  id: number;
  companyId: number;
  /** First day of the user's financial year (`YYYY-MM-DD`) for `fyStart` / `fyEnd`; default 1 April of today's. */
  fiscalYearStart?: string;
}

/** Who is running: from the request (token, session). */
export interface ReportUserSource<U extends ReportUser = ReportUser> {
  current(): U;
}

/**
 * The scope values a user may read (`reports.rowScope`): null for all, a list otherwise (empty: none). Read once per
 * run, in its transaction.
 */
export interface ReportRowScopeSource<U extends ReportUser = ReportUser> {
  allowed(user: U, t?: Transaction): Promise<Array<number | string> | null>;
}

/** A saved report or pivot as the project stores it. */
export interface StoredReport {
  id: number;
  definition: Rdl2Report<Rdl2StageBase> | Rdl2PivotView;
  /** `archived` is not listed or run. */
  status?: string;
  /** Column values used when the definition lacks them. */
  title?: string;
  category?: string;
  description?: string;
  /** Kept by the project, never deleted from the studio. */
  system?: boolean;
}

/** What the studio writes. */
export interface ReportWrite {
  definition: Rdl2Report<Rdl2StageBase> | Rdl2PivotView;
  status: string;
}

/**
 * Where a project keeps its saved reports and pivots (`features.reports.store`). Every call is for the user's company
 * (`user.companyId`), inside the given transaction when there is one.
 */
export interface ReportStore<U extends ReportUser = ReportUser> {
  /** Saved reports and pivots of the company, archived ones included (the framework leaves them out). */
  list(user: U): Promise<StoredReport[]>;
  get(user: U, id: number, t?: Transaction): Promise<StoredReport | null>;
  byName(user: U, name: string, t?: Transaction): Promise<StoredReport | null>;
  create(user: U, write: ReportWrite, t: Transaction): Promise<{ id: number }>;
  update(user: U, id: number, write: ReportWrite, t: Transaction): Promise<void>;
  /** Saved pivots whose source is `report`, at most `limit`. */
  pivotsOf(user: U, report: string, limit: number, t: Transaction): Promise<number[]>;
  remove(user: U, ids: readonly number[], t: Transaction): Promise<void>;
}
