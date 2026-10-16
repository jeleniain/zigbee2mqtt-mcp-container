import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Only explicitly invoked by the manual workflow, never by node --test.
const image = process.argv[2];
assert.ok(image, 'Provide the locally built image tag');
const name = `z2m-mcp-smoke-${process.pid}`;
const key = 'offline-smoke-key-not-a-production-secret';
const docker = (...args) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
};

async function probe() {
  const assert = (await import('node:assert/strict')).default;
  const { readFileSync, readdirSync } = await import('node:fs');
  assert.notEqual(process.getuid(), 0);
  const key = 'offline-smoke-key-not-a-production-secret';
  const endpoint = 'http://127.0.0.1:8000/mcp';
  const headers = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    connection: 'close',
    'mcp-protocol-version': '2025-06-18',
  };
  const children = () => readdirSync('/proc').filter((pid) => {
    if (!/^\d+$/.test(pid)) return false;
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      return command[1] === '/opt/zigbee2mqtt-mcp/dist/index.js';
    } catch { return false; }
  }).sort();
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 401);
      ready = true;
      break;
    } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, 'Gateway must start and reject anonymous requests');
  assert.equal((await fetch(endpoint, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const rpc = async (message) => {
    const response = await fetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const session = response.headers.get('mcp-session-id');
    if (session) headers['mcp-session-id'] = session;
    const body = await response.text();
    if (response.headers.get('content-type')?.includes('application/json')) return JSON.parse(body);
    const data = body.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)));
    return data.find((message) => message.id !== undefined);
  };
  const initialized = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'offline-smoke', version: '1' },
  } });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.ok(headers['mcp-session-id']);
  const original = children();
  assert.equal(original.length, 1);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({
    jsonrpc: '2.0', method: 'notifications/initialized',
  }), signal: AbortSignal.timeout(5000) })).status, 202);
  const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), [
    'z2m_connection_status', 'z2m_get_device', 'z2m_get_logs',
    'z2m_health_report', 'z2m_list_devices', 'z2m_list_groups',
  ]);
  for (const tool of ['z2m_network_map', 'z2m_coordinator_check', 'z2m_bridge_info', 'z2m_permit_join']) {
    const denied = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: {} } });
    assert.equal(denied.error.code, -32602);
  }
  assert.deepEqual(children(), original, 'Completed HTTP requests retain the same session child');
  const environment = readFileSync(`/proc/${original[0]}/environ`, 'utf8');
  assert.ok(!environment.includes('SUPERGATEWAY_API_KEY='), 'Child must not inherit the gateway credential');
  assert.ok(!environment.includes(key), 'Child environment must not contain the gateway key value');
  assert.match(environment, /Z2M_WRITE_MODE=off\0/);
  assert.match(environment, /Z2M_MQTT_REJECT_UNAUTHORIZED=true\0/);
  assert.match(environment, /Z2M_LOG_LEVEL=silent\0/);
  assert.match(environment, /Z2M_MQTT_CLIENT_ID=z2m-mcp-[0-9a-f-]+-\d+\0/);
  // No allowed tools are called: tools/list, initialize, and denied calls do not connect MQTT.
}

try {
  docker('run', '--detach', '--name', name, '--init', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--network', 'none',
    '--env', `SUPERGATEWAY_API_KEY=${key}`, '--env', 'Z2M_MQTT_URL=mqtt://127.0.0.1:1883', image);
  docker('exec', name, 'node', '--input-type=module', '-e', `await (${probe.toString()})()`);
  docker('stop', '--time', '10', name);
  assert.equal(docker('inspect', '--format', '{{.State.ExitCode}}', name), '0', 'SIGTERM must exit cleanly, not SIGKILL');
  console.log('Offline container smoke checks passed');
} finally {
  spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore', timeout: 30_000 });
}
