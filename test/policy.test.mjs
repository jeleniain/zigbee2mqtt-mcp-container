import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { configure, tools } from '../entrypoint.mjs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const valid = () => ({
  SUPERGATEWAY_API_KEY: 'test-only-not-a-real-secret',
  Z2M_MQTT_URL: 'mqtt://127.0.0.1:1883',
});

test('missing, empty, whitespace, and malformed API keys fail closed', () => {
  for (const key of [undefined, '', '  ', 'key with spaces', 'key\nvalue', '\u00e9']) {
    assert.throws(() => configure({ ...valid(), SUPERGATEWAY_API_KEY: key }), /API_KEY/);
  }
  assert.throws(() => configure({ ...valid(), SUPERGATEWAY_API_KEY_FILE: '/secret' }), /Key files/);
});

test('broker URL is required, supported, and credential-free', () => {
  for (const url of [undefined, '', 'not a URL', 'http://broker', 'mqtt:///']) {
    assert.throws(() => configure({ ...valid(), Z2M_MQTT_URL: url }), /Z2M_MQTT_URL/);
  }
  for (const url of ['mqtt://user:password@broker', 'mqtt://@broker', 'wss://user@broker/mqtt']) {
    assert.throws(() => configure({ ...valid(), Z2M_MQTT_URL: url }), /userinfo/);
  }
  for (const url of ['mqtt://broker', 'mqtts://broker:8883', 'ws://broker/mqtt', 'wss://broker/mqtt']) {
    assert.doesNotThrow(() => configure({ ...valid(), Z2M_MQTT_URL: url }));
  }
});

test('unsafe policy overrides are forced safe and command overrides refused', () => {
  const env = { ...valid(), Z2M_WRITE_MODE: 'full', Z2M_LOG_LEVEL: 'debug', Z2M_MQTT_REJECT_UNAUTHORIZED: 'false' };
  configure(env);
  assert.equal(env.Z2M_WRITE_MODE, 'off');
  assert.equal(env.Z2M_LOG_LEVEL, 'silent');
  assert.equal(env.Z2M_MQTT_REJECT_UNAUTHORIZED, 'true');
  assert.throws(() => configure(valid(), ['--tools', 'z2m_network_map']), /overrides/);
  assert.throws(() => configure({ ...valid(), Z2M_MQTT_CLIENT_ID: 'fixed' }), /Fixed/);
});

test('exact six-tool passive allowlist and session settings cannot drift silently', () => {
  assert.deepEqual([...tools], [
    'z2m_connection_status', 'z2m_list_devices', 'z2m_get_device',
    'z2m_health_report', 'z2m_list_groups', 'z2m_get_logs',
  ]);
  const args = configure(valid());
  assert.deepEqual(args, [
    '--stdio', 'exec /bin/sh /opt/container/child.sh',
    '--outputTransport', 'streamableHttp', '--host', '0.0.0.0',
    '--port', '8000', '--streamableHttpPath', '/mcp', '--stateful',
    '--sessionTimeout', '1800000', '--logLevel', 'none',
    ...tools.flatMap((name) => ['--tools', name]),
  ]);
});

test('container starts have unique prefixes and child launcher adds its PID then execs', () => {
  const first = valid();
  const second = valid();
  configure(first);
  configure(second);
  assert.match(first.Z2M_CONTAINER_CLIENT_PREFIX, /^z2m-mcp-[0-9a-f-]{36}$/);
  assert.notEqual(first.Z2M_CONTAINER_CLIENT_PREFIX, second.Z2M_CONTAINER_CLIENT_PREFIX);
  const child = read('child.sh');
  assert.ok(child.includes('Z2M_CONTAINER_CLIENT_PREFIX:?'));
  assert.ok(child.includes('Z2M_MQTT_CLIENT_ID="${Z2M_CONTAINER_CLIENT_PREFIX}-$$"'));
  assert.ok(child.includes('exec /usr/local/bin/node /opt/zigbee2mqtt-mcp/dist/index.js'));
  assert.ok(!child.includes('\r'));
});

test('real startup rejects invalid configuration without revealing credentials', () => {
  const env = { ...process.env, ...valid(), Z2M_MQTT_URL: 'mqtt://private:do-not-print@broker' };
  const entrypoint = fileURLToPath(new URL('../entrypoint.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entrypoint], { env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Container startup refused/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('do-not-print'));
  const noKey = { ...process.env, Z2M_MQTT_URL: 'mqtt://127.0.0.1:1883' };
  delete noKey.SUPERGATEWAY_API_KEY;
  const missing = spawnSync(process.execPath, [entrypoint], { env: noKey, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Container startup refused/);
});

test('successful startup imports the gateway in-process and survives detached stdin EOF', () => {
  // In-memory module hooks replace only the absent gateway, not startup policy.
  const dataUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
  const mock = dataUrl(`
    import assert from 'node:assert/strict';
    import { PassThrough } from 'node:stream';
    assert.ok(process.stdin instanceof PassThrough);
    process.stdin.on('close', () => process.exit(91));
    process.stdin.resume();
    console.log(JSON.stringify({ args: process.argv.slice(2), mode: process.env.Z2M_WRITE_MODE }));
    setTimeout(() => process.exit(0), 50);
  `);
  const hooks = dataUrl(`
    export function resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('/opt/supergateway/dist/index.js')) {
        return { url: ${JSON.stringify(mock)}, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
  `);
  const preload = dataUrl(`import { register } from 'node:module'; register(${JSON.stringify(hooks)});`);
  const result = spawnSync(process.execPath, [
    '--import', preload, fileURLToPath(new URL('../entrypoint.mjs', import.meta.url)),
  ], { env: { ...process.env, ...valid() }, encoding: 'utf8', input: '', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const observed = JSON.parse(result.stdout);
  assert.deepEqual(observed.args, configure(valid()));
  assert.equal(observed.mode, 'off');
});

test('MIT licenses match upstream bytes at pinned commits', () => {
  const expected = {
    'zigbee2mqtt-mcp': '72a031709c1b0e10d5785423b7c77a560e3074c512b64df9c6e5bdd5b5bfc302',
    supergateway: '0ebbc82680d40155e75adebff2e9ab90a8215fe719fbfde6a8f11cb2ad5ad27a',
  };
  for (const [name, hash] of Object.entries(expected)) {
    const bytes = readFileSync(new URL(`licenses/${name}.LICENSE`, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, name);
  }
});

test('Docker context is a positive list and runtime is non-root with compiled local entrypoints', () => {
  const entries = read('.dockerignore').split('\n').filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(entries, [
    '**', '!Dockerfile', '!.dockerignore', '!entrypoint.mjs', '!child.sh',
    '!licenses/', '!licenses/zigbee2mqtt-mcp.LICENSE', '!licenses/supergateway.LICENSE',
  ]);
  const docker = read('Dockerfile');
  assert.equal((docker.match(/FROM node:24\.21\.0-bookworm-slim@sha256:[a-f0-9]{64}/g) ?? []).length, 2);
  assert.equal((docker.match(/ADD --checksum=sha256:[a-f0-9]{64}/g) ?? []).length, 2);
  assert.match(docker, /USER node/);
  assert.match(docker, /STOPSIGNAL SIGTERM/);
  assert.match(docker, /ENTRYPOINT \["node", "\/opt\/container\/entrypoint.mjs"\]/);
  assert.ok(!read('entrypoint.mjs').includes('spawn('));
  assert.ok(!read('child.sh').includes('npx'));
});

test('workflow is manual, action pins are immutable, publication is separately gated', () => {
  const workflow = read('.github/workflows/build.yml');
  assert.match(workflow, /on:\n  workflow_dispatch:/);
  assert.ok(!/^  (push|pull_request|schedule):/m.test(workflow));
  const actions = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
  assert.ok(actions.length > 0);
  for (const action of actions) assert.match(action, /^[\w/-]+@[0-9a-f]{40}$/);
  assert.match(workflow, /if: \$\{\{ inputs.publish && github.ref_name == github.event.repository.default_branch \}\}/);
  assert.match(workflow, /publish:\n[\s\S]*?type: boolean\n        default: false/);
  assert.match(workflow, /stable:\n[\s\S]*?type: boolean\n        default: false/);
  assert.equal((workflow.match(/packages: write/g) ?? []).length, 1);
  assert.match(workflow, /if \[ "\$STABLE" = true \]; then echo "\$\{image\}:stable"; fi/);
  assert.match(workflow, /run: node --test/);
  assert.match(read('scripts/container-smoke.mjs'), /'--network', 'none'/);
});
