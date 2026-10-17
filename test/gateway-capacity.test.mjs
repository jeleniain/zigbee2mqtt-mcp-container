import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

// The pinned supergateway, built and patched by scripts/install-gateway-policy.mjs.
const fixture = process.env.Z2M_GATEWAY_FIXTURE;
const key = 'test-only-not-a-real-secret';
const endpoint = 'http://127.0.0.1:8000/mcp';
const repo = (path) => new URL(`../${path}`, import.meta.url).href;
const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

// A minimal stdio MCP server standing in for the application, which needs a broker.
const application = `
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const lines = (buffered + chunk).split('\\n');
    buffered = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line);
      if (message.id === undefined || !message.method) continue;
      const result = message.method === 'initialize'
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'z2m_connection_status', inputSchema: { type: 'object' } }] }
          : {};
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    }
  });
`;

// The real limiter and launcher; only the launched entry is the fake application.
const childPolicy = dataUrl(`
  import { createApplicationLauncher, createChildLimiter } from ${JSON.stringify(repo('child-policy.mjs'))};
  export * from ${JSON.stringify(repo('child-policy.mjs'))};
  const limited = createChildLimiter();
  const launch = createApplicationLauncher();
  const fake = (spawn) => (command, _args, options) => spawn(command, ['-e', ${JSON.stringify(application)}], options);
  export const boundedSpawn = (spawn, ...args) => limited(launch, fake(spawn), ...args);
`);

function startGateway() {
  const targets = {
    '/opt/container/child-policy.mjs': childPolicy,
    '/opt/container/http-policy.mjs': repo('http-policy.mjs'),
  };
  const hooks = dataUrl(`
    const targets = ${JSON.stringify(targets)};
    const gateway = ${JSON.stringify(pathToFileURL(join(fixture ?? '', 'dist/index.js')).href)};
    export function resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('/opt/supergateway/dist/index.js')) return nextResolve(gateway, context);
      if (targets[specifier]) return nextResolve(targets[specifier], context);
      return nextResolve(specifier, context);
    }
  `);
  const preload = dataUrl(`import { register } from 'node:module'; register(${JSON.stringify(hooks)});`);
  const gateway = spawn(process.execPath, ['--import', preload, fileURLToPath(repo('entrypoint.mjs'))], {
    env: {
      ...process.env,
      SUPERGATEWAY_API_KEY: key,
      Z2M_MQTT_URL: 'mqtts://127.0.0.1:8883',
      Z2M_HTTP_ALLOWED_HOSTS: '127.0.0.1:8000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  gateway.stdout.on('data', (chunk) => { output += chunk; });
  gateway.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => gateway.once('exit', (code, signal) => resolve({ code, signal })));
  return { gateway, exited, output: () => output };
}

const headers = (session) => ({
  authorization: `Bearer ${key}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-06-18',
  ...(session ? { 'mcp-session-id': session } : {}),
});
const post = (message, session) => fetch(endpoint, {
  method: 'POST', headers: headers(session), body: JSON.stringify(message), signal: AbortSignal.timeout(5000),
});
const reply = async (response) => {
  const body = await response.text();
  if (response.headers.get('content-type')?.includes('application/json')) return JSON.parse(body);
  return body.split('\n').filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5))).find((message) => message.id !== undefined);
};
// A 2026-07-28 request: no session, a child started for this request alone.
const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'capacity-test', version: '1' },
};
const modern = (message) => fetch(endpoint, {
  method: 'POST',
  headers: { ...headers(), 'mcp-protocol-version': '2026-07-28', 'mcp-method': message.method },
  body: JSON.stringify({ jsonrpc: '2.0', ...message, params: { ...message.params, _meta: modernMeta } }),
  signal: AbortSignal.timeout(5000),
});
const modernList = () => modern({ id: 30, method: 'tools/list' });
const modernCancel = () => modern({ method: 'notifications/cancelled', params: { requestId: 30 } });
const initialize = () => post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'capacity-test', version: '1' },
} });

async function assertRefused(response) {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(response.headers.get('mcp-session-id'), null);
  assert.equal(await response.text(), 'Gateway session capacity reached');
}

// A slot is released when its child exits, shortly after its session or request ends.
async function untilAdmitted(send) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await send();
    if (response.status !== 503) return response;
    await assertRefused(response);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('A released slot must be admitted again');
}

async function open() {
  const response = await untilAdmitted(initialize);
  assert.equal(response.status, 200);
  const session = response.headers.get('mcp-session-id');
  assert.ok(session);
  assert.equal((await reply(response)).result.serverInfo.name, 'fake');
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session)).status, 202);
  return session;
}

// CI must never silently skip this test.
test('sessions over capacity are refused with 503 while the gateway and live sessions keep running', {
  skip: !fixture && !process.env.GITHUB_ACTIONS && 'Set Z2M_GATEWAY_FIXTURE to a patched, built supergateway checkout',
  timeout: 60_000,
}, async () => {
  assert.ok(fixture, 'Z2M_GATEWAY_FIXTURE is required in CI');
  const { gateway, exited, output } = startGateway();
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      try {
        ready = (await fetch(endpoint, { signal: AbortSignal.timeout(1000) })).status === 401;
      } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    assert.ok(ready, `Gateway must start: ${output()}`);

    // Below capacity, a per-request child starts, answers, and is released.
    const listedModern = await modernList();
    assert.equal(listedModern.status, 200);
    assert.deepEqual((await reply(listedModern)).result.tools.map((tool) => tool.name), ['z2m_connection_status']);

    const sessions = [];
    for (let index = 0; index < 4; index++) sessions.push(await open());
    // Several refusals in a row, on both paths, must not consume or release capacity.
    for (let attempt = 0; attempt < 3; attempt++) {
      await assertRefused(await initialize());
      await assertRefused(await modernList());
      await assertRefused(await modernCancel());
    }
    assert.equal(gateway.exitCode, null, `Gateway must survive refusals: ${output()}`);

    for (const [index, session] of sessions.entries()) {
      const response = await post({ jsonrpc: '2.0', id: 10 + index, method: 'tools/list' }, session);
      assert.equal(response.status, 200);
      assert.deepEqual((await reply(response)).result.tools.map((tool) => tool.name), ['z2m_connection_status']);
    }

    // Ending a session stops its child, and its exit frees exactly one slot.
    const ended = await fetch(endpoint, { method: 'DELETE', headers: headers(sessions.shift()), signal: AbortSignal.timeout(5000) });
    assert.equal(ended.status, 200);
    sessions.push(await open());
    await assertRefused(await initialize());
    await assertRefused(await modernList());

    const listed = await post({ jsonrpc: '2.0', id: 20, method: 'tools/list' }, sessions.at(-1));
    assert.equal(listed.status, 200);
    assert.equal(gateway.exitCode, null, `Gateway must survive: ${output()}`);
    assert.doesNotMatch(output(), /capacity|Error/, 'Refusals are not logged as failures');
  } finally {
    gateway.kill('SIGTERM');
    await exited;
  }
});
