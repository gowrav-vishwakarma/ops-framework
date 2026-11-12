import { describe, expect, it } from 'vitest';
import { UNSET_SEARCH_PATH, connectionOptions } from './connection-registry.js';

describe('connectionOptions SSL', () => {
  it('requires SSL when the URI says sslmode=require (Cloud SQL private IP)', () => {
    const options = connectionOptions(10, 'postgres://tms_app:pw@10.20.0.3:5432/tms?sslmode=require');
    expect(options.dialectOptions).toEqual({
      options: `-c search_path=${UNSET_SEARCH_PATH}`,
      ssl: { require: true, rejectUnauthorized: false },
    });
  });

  it('does not use SSL for a plain local URI', () => {
    const options = connectionOptions(10, 'postgres://postgres:password@localhost:5434/tms');
    expect(options.dialectOptions).not.toHaveProperty('ssl');
  });
});
