import { BelongsTo, Column, DataType, ForeignKey, HasMany, Table } from 'sequelize-typescript';
import type { Rel } from '../../db/rel.js';
import { TenantModel, tenantTable } from '../../db/tenant.model.js';

/**
 * A small trading company: the models the sample reports (`reports.ts`) read. snake_case columns (`underscored`), as
 * a project with that naming has them, so the samples also show that reports name attributes, never columns.
 *
 *   Branch ─< Invoice ─< InvoiceLine >─ Product >─ Category (a tree: `left` / `right`)
 *              │ └── Party >─ Branch (home branch)
 *   Branch ─< Payment >─ Party        Branch ─< StockMove >─ Product
 */

const naming = { underscored: true };

@Table(tenantTable('branches', [], naming))
export class Branch extends TenantModel {
  @Column({ type: DataType.STRING(80), allowNull: false })
  name: string;
}

@Table(tenantTable('parties', [], naming))
export class Party extends TenantModel {
  @Column({ type: DataType.STRING(120), allowNull: false })
  name: string;

  @Column({ type: DataType.STRING(60), allowNull: true })
  city: string | null;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  creditLimit: string;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  isActive: boolean;

  /** Never readable by a report: the catalog drops fields named like secrets. */
  @Column({ type: DataType.STRING(120), allowNull: true })
  portalPassword: string | null;
}

/** Product categories as a nested set: a category's `left`..`right` holds every category under it. */
@Table(tenantTable('categories', [], naming))
export class Category extends TenantModel {
  @Column({ type: DataType.STRING(80), allowNull: false })
  name: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  left: number;

  @Column({ type: DataType.INTEGER, allowNull: false })
  right: number;
}

@Table(tenantTable('products', [], naming))
export class Product extends TenantModel {
  @Column({ type: DataType.STRING(120), allowNull: false })
  name: string;

  @Column({ type: DataType.STRING(20), allowNull: true })
  sku: string | null;

  @ForeignKey(() => Category)
  @Column({ type: DataType.INTEGER, allowNull: true })
  categoryId: number | null;

  @BelongsTo(() => Category)
  category?: Rel<Category>;
}

/** Sales invoices. Soft deleted (`deleted_at`): a deleted invoice never reaches a report. */
@Table(tenantTable('invoices', [], { ...naming, softDelete: true }))
export class Invoice extends TenantModel {
  @ForeignKey(() => Branch)
  @Column({ type: DataType.INTEGER, allowNull: false })
  branchId: number;

  @ForeignKey(() => Party)
  @Column({ type: DataType.INTEGER, allowNull: false })
  partyId: number;

  @Column({ type: DataType.STRING(30), allowNull: false })
  number: string;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  invoiceDate: string;

  @Column({ type: DataType.DATEONLY, allowNull: true })
  dueDate: string | null;

  @Column({ type: DataType.ENUM('draft', 'posted', 'cancelled'), allowNull: false, defaultValue: 'posted' })
  status: 'draft' | 'posted' | 'cancelled';

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  total: string;

  @BelongsTo(() => Branch)
  branch?: Rel<Branch>;

  @BelongsTo(() => Party)
  party?: Rel<Party>;

  @HasMany(() => InvoiceLine)
  lines?: Rel<InvoiceLine[]>;
}

/** Invoice lines: no branch of their own, they reach it through `invoice` (found by their name). */
@Table(tenantTable('invoice_lines', [], naming))
export class InvoiceLine extends TenantModel {
  @ForeignKey(() => Invoice)
  @Column({ type: DataType.INTEGER, allowNull: false })
  invoiceId: number;

  @ForeignKey(() => Product)
  @Column({ type: DataType.INTEGER, allowNull: false })
  productId: number;

  @Column({ type: DataType.DECIMAL(14, 3), allowNull: false })
  qty: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false })
  rate: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false })
  amount: string;

  @BelongsTo(() => Invoice)
  invoice?: Rel<Invoice>;

  @BelongsTo(() => Product)
  product?: Rel<Product>;
}

@Table(tenantTable('payments', [], naming))
export class Payment extends TenantModel {
  @ForeignKey(() => Branch)
  @Column({ type: DataType.INTEGER, allowNull: false })
  branchId: number;

  @ForeignKey(() => Party)
  @Column({ type: DataType.INTEGER, allowNull: false })
  partyId: number;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  paidOn: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false })
  amount: string;

  @BelongsTo(() => Party)
  party?: Rel<Party>;
}

/** Stock movements: quantity in and out per product, branch and day. */
@Table(tenantTable('stock_moves', [], naming))
export class StockMove extends TenantModel {
  @ForeignKey(() => Branch)
  @Column({ type: DataType.INTEGER, allowNull: false })
  branchId: number;

  @ForeignKey(() => Product)
  @Column({ type: DataType.INTEGER, allowNull: false })
  productId: number;

  @Column({ type: DataType.DATEONLY, allowNull: false })
  day: string;

  @Column({ type: DataType.DECIMAL(14, 3), allowNull: false, defaultValue: 0 })
  qtyIn: string;

  @Column({ type: DataType.DECIMAL(14, 3), allowNull: false, defaultValue: 0 })
  qtyOut: string;

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, defaultValue: 0 })
  rate: string;

  @BelongsTo(() => Product)
  product?: Rel<Product>;
}

export const SAMPLE_MODELS = [Branch, Party, Category, Product, Invoice, InvoiceLine, Payment, StockMove];
