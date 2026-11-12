import { describe, expect, it } from 'vitest';
import { bodyForLog, redactForLog } from './request-log.js';

describe('request logging', () => {
  it('never writes passwords, and only the start of tokens, at any depth', () => {
    const logged = redactForLog(
      { email: 'a@b.c', password: 'secret!', data: { accessToken: 'eyJhbGciOiJIUzI1NiJ9.payload.sig', companies: [{ token: 'short' }] } },
      new Set(['password']),
      new Set(['accessToken', 'token']),
    );
    expect(logged).toEqual({ email: 'a@b.c', password: '[REDACTED]', data: { accessToken: 'eyJhbGciOiJI…(32)', companies: [{ token: 'short' }] } });
  });

  it('cuts long bodies and keeps short ones as JSON', () => {
    expect(bodyForLog({ a: 1 }, 100)).toEqual({ a: 1 });
    expect(bodyForLog({ text: 'x'.repeat(50) }, 20)).toMatch(/^\{"text":"x+…\(61 chars\)$/);
  });
});
