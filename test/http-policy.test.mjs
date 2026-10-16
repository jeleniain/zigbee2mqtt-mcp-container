import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedHosts, createHttpPolicy } from '../http-policy.mjs';

test('HTTP authorities must be explicitly configured, exact and not wildcard URLs', () => {
  for (const value of [undefined, '', '*', 'https://gateway', 'gateway/path', 'user@gateway', 'gateway?token=x', 'gateway#x', 'gateway,']) {
    assert.throws(() => allowedHosts({ Z2M_HTTP_ALLOWED_HOSTS: value }));
  }
  assert.deepEqual([...allowedHosts({ Z2M_HTTP_ALLOWED_HOSTS: 'gateway.example:8000,127.0.0.1:8000,[::1]:8000' })],
    ['gateway.example:8000', '127.0.0.1:8000', '[::1]:8000']);
});

test('Host and Origin checks run independently of authentication and forwarded headers', () => {
  const middleware = createHttpPolicy({ Z2M_HTTP_ALLOWED_HOSTS: 'gateway.example:8000' });
  const invoke = (host, rawHeaders) => {
    let status;
    let advanced = false;
    middleware({ headers: { host, authorization: 'Bearer synthetic', 'x-forwarded-host': 'gateway.example:8000' }, rawHeaders },
      { status(code) { status = code; return this; }, send() {} }, () => { advanced = true; });
    return { status, advanced };
  };
  assert.deepEqual(invoke('gateway.example:8000', ['Host', 'gateway.example:8000']), { status: undefined, advanced: true });
  for (const [host, headers] of [
    ['evil.example', ['Host', 'evil.example']],
    ['gateway.example:8000', ['Host', 'gateway.example:8000', 'Origin', 'https://gateway.example']],
    ['gateway.example:8000', ['Host', 'gateway.example:8000', 'Origin', 'null']],
    ['gateway.example:8000', ['Host', 'gateway.example:8000', 'Host', 'gateway.example:8000']],
    [undefined, []],
  ]) assert.deepEqual(invoke(host, headers), { status: 403, advanced: false });
});
