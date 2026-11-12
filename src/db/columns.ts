import { Column, DataType } from 'sequelize-typescript';
import { MONEY, QTY } from './tenant.model.js';

type Opts = { nullable?: boolean; default?: unknown };

const base = (type: unknown, { nullable = false, default: fallback }: Opts = {}) =>
  Column({ type: type as never, allowNull: nullable, ...(fallback !== undefined ? { defaultValue: fallback } : {}) });

/** Short text. Required unless `nullable`. */
export const Str = (length = 120, options: Opts = {}) => base(DataType.STRING(length), options);
export const LongText = (options: Opts = { nullable: true }) => base(DataType.TEXT, options);
/** A string enum stored as text; allowed values are checked by the DTO. */
export const Choice = (fallback: string, length = 20) => base(DataType.STRING(length), { default: fallback });
/** `DECIMAL(14,2)` rupees. Reads back as a string. */
export const Money = (options: Opts = { default: 0 }) => base(MONEY, options);
/** `DECIMAL(14,3)` weights, litres and km. */
export const Qty = (options: Opts = { default: 0 }) => base(QTY, options);
export const Int = (options: Opts = {}) => base(DataType.INTEGER, options);
export const Flag = (fallback = false) => base(DataType.BOOLEAN, { default: fallback });
/** `YYYY-MM-DD`. */
export const Day = (options: Opts = {}) => base(DataType.DATEONLY, options);
export const Stamp = (options: Opts = {}) => base(DataType.DATE, options);
export const Json = (options: Opts = { nullable: true }) => base(DataType.JSONB, options);

/** A foreign key column. The constraint is created from `table`. */
export const Fk = (table: string, options: { nullable?: boolean; onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' } = {}) =>
  Column({
    type: DataType.INTEGER,
    allowNull: options.nullable ?? false,
    references: { model: table, key: 'id' },
    onDelete: options.onDelete ?? (options.nullable ? 'SET NULL' : 'RESTRICT'),
  });
