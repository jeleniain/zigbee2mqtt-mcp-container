import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BASELINE, LIMITS, intake, hardenTools, projectDevice, projectGroups, projectOutput, projectTelemetry } from '../scripts/security-boundary.mjs';
import { patchSource } from '../scripts/patch-upstream-security.mjs';

const SECRET = 'SYNTHETIC_DISCLOSURE_CANARY_74b9';
const ieee = '0x00124b0000000001';
const rawDevice = { friendly_name: 'desk/sensor', ieee_address: ieee, type: 'EndDevice', supported: true,
  interview_state: 'SUCCESSFUL', description: SECRET,
  definition: { model: 'SyntheticSensor', vendor: 'FixtureVendor', description: SECRET,
    exposes: [{ property: SECRET, values: [SECRET], features: [{ description: SECRET }] }],
    options: [{ property: 'password', values: [SECRET] }] },
  endpoints: { 1: { bindings: [SECRET], configured_reportings: [SECRET] } }, options: { password: SECRET } };
const telemetry = { battery: 12, battery_low: true, linkquality: 30, last_seen: '2020-01-01T00:00:00.000Z',
  state: SECRET, pin: SECRET, action: SECRET, update: { state: 'available', installed_version: 1, latest_version: 2,
    password: SECRET, nested: { secret: SECRET } } };
const group = { id: 1, friendly_name: 'FixtureGroup', members: [{ ieee_address: ieee, endpoint: 1, password: SECRET }],
  scenes: [{ name: SECRET }], state: SECRET, options: { password: SECRET } };
function cacheClient() {
  return { config: { baseTopic: 'fixture' }, bridge: new Map(), bridgeRevision: 0, deviceState: new Map(), availability: new Map(), logs: [], events: [], lastMessageAt: 0 };
}
const send = (client, suffix, payload) => intake(client, `fixture/${suffix}`, Buffer.from(JSON.stringify(payload)));
const noSecret = (v) => assert.equal(JSON.stringify(v).includes(SECRET), false);

test('telemetry/update and device output use closed field and scalar projections', () => {
  const projected = projectTelemetry(telemetry);
  assert.deepEqual(projected.update, { state: 'available', installed_version: 1, latest_version: 2 });
  noSecret(projected);
  const bad = projectTelemetry({ battery: Infinity, linkquality: { secret: SECRET }, last_seen: SECRET,
    update: { state: SECRET, installed_version: { secret: SECRET }, latest_version: SECRET } });
  assert.deepEqual(bad, { update: {} });
  noSecret(projectDevice({ ...rawDevice, ...telemetry, model: { secret: SECRET }, current_state: telemetry,
    raw_exposes: rawDevice.definition.exposes, settable_options: rawDevice.definition.options }));
  assert.equal(projectDevice({ battery: '12', disabled: SECRET }).battery, undefined);
});

test('group projection never forwards scenes, options or nested member values', () => {
  assert.deepEqual(projectGroups([group]), [{ id: 1, friendly_name: 'FixtureGroup', members: [{ ieee_address: ieee, endpoint: 1 }] }]);
  noSecret(projectOutput('z2m_list_groups', { groups: [group], password: SECRET }));
});

test('intake retains only projected bridge/device data and severity metadata', () => {
  const client = cacheClient();
  send(client, 'bridge/devices', [rawDevice]);
  send(client, 'bridge/info', { version: '2.0.0', network: { network_key: SECRET }, mqtt: { password: SECRET },
    coordinator: { type: 'ember', meta: { secret: SECRET } }, config: { advanced: { last_seen: 'ISO_8601', network_key: SECRET }, availability: { enabled: true, secret: SECRET } } });
  send(client, 'bridge/health', { devices: { [ieee]: { messages: 0, leave_count: 2, network_address_changes: 1, secret: SECRET } }, secret: SECRET });
  send(client, 'bridge/groups', [group]);
  send(client, 'bridge/state', { state: 'online', secret: SECRET });
  send(client, 'desk/sensor', telemetry);
  send(client, 'desk/sensor/availability', { state: 'offline', secret: SECRET });
  send(client, 'bridge/logging', { level: 'error', message: SECRET, namespace: SECRET });
  for (const suffix of ['bridge/event', 'bridge/response/networkmap', 'bridge/config', 'bridge/request/options', 'unregistered', 'desk/sensor/set']) send(client, suffix, { secret: SECRET });
  assert.equal(client.bridge.size, 5);
  assert.equal(client.deviceState.size, 1);
  assert.equal(client.availability.get('desk/sensor'), 'offline');
  assert.equal(client.events.length, 0);
  assert.equal(client.logs[0].message, '');
  noSecret([...client.bridge]); noSecret([...client.deviceState]); noSecret(client.logs);
  assert.deepEqual(Object.keys(client.bridge.get('devices')[0].endpoints), ['1']);
});

test('intake bounds payload/topic/cache sizes, rejects malformed input and prunes an empty estate', () => {
  const client = cacheClient();
  send(client, 'bridge/devices', [rawDevice]);
  send(client, 'desk/sensor', telemetry);
  send(client, 'desk/sensor/availability', { state: 'online' });
  intake(client, 'fixture/bridge/info', Buffer.alloc(LIMITS.payloadBytes + 1, 0x20));
  intake(client, 'fixture/bridge/info', Buffer.from('{not json'));
  intake(client, `fixture/${'x'.repeat(LIMITS.topicBytes)}`, Buffer.from('{}'));
  assert.equal(client.bridge.has('info'), false);
  send(client, 'bridge/devices', Array.from({ length: LIMITS.devices + 1 }, () => rawDevice));
  assert.equal(client.bridge.get('devices').length, 1);
  for (let i = 0; i < 1005; i++) send(client, 'bridge/logging', { level: 'info', message: SECRET });
  assert.equal(client.logs.length, 1000);
  send(client, 'bridge/devices', []);
  assert.equal(client.deviceState.size, 0);
  assert.equal(client.availability.size, 0);
  send(client, 'unknown', telemetry);
  assert.equal(client.deviceState.size, 0);
});

test('connection/health outputs omit arbitrary nested values and all free-form diagnostics', () => {
  noSecret(projectOutput('z2m_connection_status', { connected: true, broker_url: SECRET, base_topic: SECRET,
    client_id: SECRET, error: SECRET, hints: [SECRET], tls: { enabled: true, ca: SECRET } }));
  const report = projectOutput('z2m_health_report', { bridge: { state: 'online', network_key: SECRET }, totals: { devices: 1 },
    issues: { offline: [{ friendly_name: 'Fixture', ieee_address: ieee, detail: SECRET }], [SECRET]: [SECRET] }, hints: [SECRET] });
  noSecret(report);
  assert.deepEqual(report.issues.offline, [{ friendly_name: 'Fixture', ieee_address: ieee }]);
  assert.throws(() => projectOutput('z2m_bridge_info', {}), /disabled/);
});

test('tool boundary exposes only six tools, rejects raw/unknown arguments and never reflects exceptions', async () => {
  let calls = 0;
  const originals = [...BASELINE, 'z2m_network_map', 'z2m_set_state'].map((name) => ({ name, inputSchema: { type: 'object', properties: { include_raw: {}, device: {} } },
    handler: async () => { calls++; throw new Error(SECRET); } }));
  const tools = hardenTools(originals);
  assert.deepEqual(tools.map((t) => t.name), BASELINE);
  const device = tools.find((t) => t.name === 'z2m_get_device');
  assert.equal(device.inputSchema.additionalProperties, false);
  assert.equal(device.inputSchema.properties.include_raw, undefined);
  for (const args of [{ device: 'Fixture', include_raw: true }, { device: { secret: SECRET } }, { device: 'Fixture', include_raw: false }]) {
    await assert.rejects(device.handler(args, {}), (error) => !error.message.includes(SECRET));
  }
  assert.equal(calls, 0);
  await assert.rejects(device.handler({ device: 'Fixture' }, {}), (error) => !error.message.includes(SECRET));
  assert.equal(calls, 1);
  const logs = tools.find((t) => t.name === 'z2m_get_logs');
  const result = await logs.handler({}, { client: { connect: async () => {}, recentLogs: () => [{ level: 'error', message: SECRET }, { level: 'warn', namespace: SECRET }] } });
  assert.deepEqual(result.buffered_severity_counts, { error: 1, warning: 1, info: 0 });
  noSecret(result);
  await assert.rejects(logs.handler({ contains: SECRET }, {}));
});

test('source assertion fails before creating or changing any files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'z2m-security-drift-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/client.ts'), 'drift');
    assert.throws(() => patchSource(dir), /Source assertion failed/);
    assert.equal(readFileSync(join(dir, 'src/client.ts'), 'utf8'), 'drift');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Set this to the externally extracted, patched and built exact source. These
// tests use the real client, normalization, health and tool handlers, not mocks
// reimplementing their semantics. No broker or production configuration is used.
const fixture = process.env.Z2M_SECURITY_FIXTURE;
// CI must never silently skip this test.
test('actual pinned client and six upstream handlers enforce the boundary', { skip: !fixture && !process.env.GITHUB_ACTIONS && 'Set Z2M_SECURITY_FIXTURE to patched/built reviewed upstream' }, async () => {
  assert.ok(fixture, 'Z2M_SECURITY_FIXTURE is required in CI');
  const load = (file) => import(pathToFileURL(resolve(fixture, 'dist', file)).href);
  const { Z2MClient } = await load('client.js');
  const { selectTools } = await load('tools.js');
  const { loadConfig } = await load('config.js');
  const { hardenTools: compiledHardenTools } = await load('security-boundary.js');
  const { toolErrorText } = await load('render.js');
  const config = { ...loadConfig({ requireMqttUrl: false }), baseTopic: 'fixture', mqttUrl: 'mqtt://synthetic.invalid', writeMode: 'off' };
  const client = new Z2MClient(config, { debug() {}, error() {}, info() {}, warn() {} });
  client.connect = async () => {};
  const actualSend = (suffix, value) => client.handleMessage(`fixture/${suffix}`, Buffer.from(JSON.stringify(value)));
  actualSend('bridge/devices', [rawDevice]); actualSend('desk/sensor', telemetry);
  actualSend('desk/sensor/availability', { state: 'offline' }); actualSend('bridge/groups', [group]);
  actualSend('bridge/info', { version: '2.0.0', config: { advanced: { last_seen: 'ISO_8601' } } });
  actualSend('bridge/state', { state: 'online' });
  actualSend('bridge/health', { devices: { [ieee]: { messages: 0, leave_count: 2 } } });
  actualSend('bridge/logging', { level: 'error', message: SECRET, namespace: SECRET });
  actualSend('bridge/event', { type: SECRET, data: { secret: SECRET } });
  const tools = compiledHardenTools(selectTools('full'));
  const results = {};
  for (const tool of tools) {
    results[tool.name] = await tool.handler(tool.name === 'z2m_get_device' ? { device: 'desk/sensor' } : {}, { client, config });
    noSecret(results[tool.name]);
  }
  assert.equal(results.z2m_list_devices.devices[0].battery, 12);
  assert.deepEqual(results.z2m_get_device.update, { state: 'available', installed_version: 1, latest_version: 2 });
  assert.equal(results.z2m_get_device.endpoint_count, 1);
  assert.equal(results.z2m_get_device.current_state, undefined);
  assert.equal(results.z2m_health_report.issues.offline.length, 1);
  assert.equal(results.z2m_health_report.issues.update_available.length, 1);
  assert.equal(results.z2m_health_report.issues.rejoining.length, 1);
  assert.equal(results.z2m_get_logs.buffered_severity_counts.error, 1);
  assert.equal(client.recentEvents().length, 0);
  await assert.rejects(client.request('health_check'), /publishing disabled/);
  await assert.rejects(client.publish('fixture/desk/set', {}), /publishing disabled/);
  assert.equal(toolErrorText(SECRET, new Error(SECRET), { password: '' }).includes(SECRET), false);
});
