import { describe, expect, it } from 'vitest';
import { connectionOptions, isPooler, UNSET_SEARCH_PATH } from './connection-registry.js';

describe('connection options', () => {
  it('sets the unusable search_path as a startup option on a direct connection', () => {
    const options = connectionOptions(5, 'postgres://u:p@localhost:5432/tms');
    expect(options.dialectOptions).toEqual({ options: `-c search_path=${UNSET_SEARCH_PATH}` });
  });

  it('sends no startup option to RDS Proxy (it refuses them) and uses SSL', () => {
    const uri = 'postgres://u:p@tms.proxy-abc123.ap-south-1.rds.amazonaws.com:5432/tms';
    expect(isPooler(uri)).toBe(true);
    expect(connectionOptions(5, uri).dialectOptions).toEqual({ ssl: { require: true, rejectUnauthorized: false } });
  });

  it('treats ?pooler=true (pgbouncer) as a pooler and keeps SSL for plain RDS', () => {
    expect(isPooler('postgres://u:p@bouncer:6432/tms?pooler=true')).toBe(true);
    const rds = connectionOptions(5, 'postgres://u:p@db.abc.ap-south-1.rds.amazonaws.com/tms');
    expect(rds.dialectOptions).toMatchObject({ options: `-c search_path=${UNSET_SEARCH_PATH}`, ssl: { require: true } });
  });
});
