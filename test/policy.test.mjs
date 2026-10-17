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
  Z2M_MQTT_URL: 'mqtts://127.0.0.1:8883',
  Z2M_HTTP_ALLOWED_HOSTS: '127.0.0.1:8000',
});

test('missing, empty, whitespace, and malformed API keys fail closed', () => {
  for (const key of [undefined, '', '  ', 'key with spaces', 'key\nvalue', '\u00e9']) {
    assert.throws(() => configure({ ...valid(), SUPERGATEWAY_API_KEY: key }), /API_KEY/);
  }
  assert.throws(() => configure({ ...valid(), SUPERGATEWAY_API_KEY_FILE: '/secret' }), /Key files/);
});

test('broker URL is required, supported, and credential-free', () => {
  for (const url of [undefined, '', 'not a URL', 'http://broker', 'mqtt:///', 'mqtt://broker', 'ws://broker/mqtt']) {
    assert.throws(() => configure({ ...valid(), Z2M_MQTT_URL: url }), /Z2M_MQTT_URL/);
  }
  for (const url of ['mqtts://user:password@broker', 'mqtts://@broker', 'wss://user@broker/mqtt']) {
    assert.throws(() => configure({ ...valid(), Z2M_MQTT_URL: url }), /userinfo/);
  }
  for (const url of ['mqtts://broker:8883', 'wss://broker/mqtt']) {
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
    '--stdio', 'z2m-application',
    '--outputTransport', 'streamableHttp', '--host', '0.0.0.0',
    '--port', '8000', '--streamableHttpPath', '/mcp', '--stateful',
    '--sessionTimeout', '1800000', '--logLevel', 'none',
    ...tools.flatMap((name) => ['--tools', name]),
  ]);
});

test('container starts have unique prefixes for per-child MQTT client IDs', () => {
  const first = valid();
  const second = valid();
  configure(first);
  configure(second);
  assert.match(first.Z2M_CONTAINER_CLIENT_PREFIX, /^z2m-mcp-[0-9a-f-]{36}$/);
  assert.notEqual(first.Z2M_CONTAINER_CLIENT_PREFIX, second.Z2M_CONTAINER_CLIENT_PREFIX);
});

test('real startup names the invalid setting without revealing any value', () => {
  const entrypoint = fileURLToPath(new URL('../entrypoint.mjs', import.meta.url));
  const marker = 'do-not-print';
  const cases = [
    [{ Z2M_MQTT_URL: `mqtts://private:${marker}@broker` }, /Z2M_MQTT_USERNAME/],
    [{ Z2M_MQTT_URL: `mqtt://${marker}.example` }, /Z2M_MQTT_URL/],
    [{ Z2M_MQTT_URL: `not a url ${marker}` }, /Z2M_MQTT_URL/],
    [{ Z2M_MQTT_URL: undefined }, /Z2M_MQTT_URL/],
    [{ SUPERGATEWAY_API_KEY: `${marker} with spaces` }, /SUPERGATEWAY_API_KEY/],
    [{ SUPERGATEWAY_API_KEY: undefined }, /SUPERGATEWAY_API_KEY/],
    [{ SUPERGATEWAY_API_KEY_FILE: `/run/${marker}` }, /SUPERGATEWAY_API_KEY/],
    [{ Z2M_MQTT_CLIENT_ID: marker }, /Z2M_MQTT_CLIENT_ID/],
    [{ Z2M_HTTP_ALLOWED_HOSTS: `user:${marker}@gateway` }, /Z2M_HTTP_ALLOWED_HOSTS/],
    [{ Z2M_HTTP_ALLOWED_HOSTS: undefined }, /Z2M_HTTP_ALLOWED_HOSTS/],
  ];
  for (const [override, expected] of cases) {
    const env = { ...process.env, ...valid(), ...override };
    for (const [name, value] of Object.entries(override)) if (value === undefined) delete env[name];
    const result = spawnSync(process.execPath, [entrypoint], { env, encoding: 'utf8' });
    assert.equal(result.status, 1, JSON.stringify(Object.keys(override)));
    assert.match(result.stderr, /^Container startup refused: /);
    assert.match(result.stderr, expected);
    assert.equal(result.stderr.trim().split('\n').length, 1, 'One line, no stack trace');
    assert.ok(!`${result.stdout}${result.stderr}`.includes(marker));
  }
});

test('gateway failures after valid configuration stay generic', () => {
  // Valid settings, but this host has no /opt/supergateway: the import fails.
  const entrypoint = fileURLToPath(new URL('../entrypoint.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entrypoint], { env: { ...process.env, ...valid() }, encoding: 'utf8', input: '' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'Container startup refused: gateway failed to start');
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
    '**', '!Dockerfile', '!.dockerignore', '!entrypoint.mjs', '!http-policy.mjs', '!child-policy.mjs',
    '!licenses/', '!licenses/zigbee2mqtt-mcp.LICENSE', '!licenses/supergateway.LICENSE',
    '!dependencies/', '!dependencies/overlay.mjs', '!dependencies/trim-runtime.mjs',
    '!dependencies/zigbee2mqtt-mcp.package-lock.json', '!dependencies/supergateway.package-lock.json',
    '!scripts/', '!scripts/install-gateway-policy.mjs', '!scripts/patch-upstream-security.mjs', '!scripts/security-boundary.mjs',
  ]);
  const docker = read('Dockerfile');
  const stages = docker.match(/^FROM .+$/gm);
  assert.equal(stages.length, 2);
  assert.match(stages[0], /^FROM node:24\.22\.0-bookworm-slim@sha256:[a-f0-9]{64} AS build$/);
  // Runtime has no shell, package manager, npm or Corepack, and runs no commands.
  assert.match(stages[1], /^FROM gcr\.io\/distroless\/cc-debian12:nonroot@sha256:[a-f0-9]{64} AS runtime$/);
  assert.ok(!docker.slice(docker.indexOf(stages[1])).includes('\nRUN '));
  assert.equal((docker.match(/ADD --checksum=sha256:[a-f0-9]{64}/g) ?? []).length, 2);
  // Output projection and publish refusal must be compiled in before the upstream build.
  assert.ok(docker.indexOf('patch-upstream-security.mjs /build/zigbee2mqtt-mcp') < docker.indexOf('npm run build'));
  assert.match(docker, /COPY entrypoint\.mjs http-policy\.mjs child-policy\.mjs \.\//);
  assert.match(docker, /^USER 65532:65532$/m);
  assert.match(docker, /STOPSIGNAL SIGTERM/);
  assert.match(docker, /ENTRYPOINT \["\/usr\/local\/bin\/node", "\/opt\/container\/entrypoint.mjs"\]/);
  assert.ok(!read('entrypoint.mjs').includes('spawn('));
  assert.ok(!docker.includes('child.sh'));
});

test('workflow is manual, action pins are immutable, publication is disabled', () => {
  const workflow = read('.github/workflows/build.yml');
  assert.match(workflow, /on:\n  workflow_dispatch:/);
  assert.ok(!/^  (push|pull_request|schedule):/m.test(workflow));
  const actions = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
  assert.ok(actions.length > 0);
  for (const action of actions) assert.match(action, /^[\w/-]+@[0-9a-f]{40}$/);
  assert.match(workflow, /publish:\n[\s\S]*?type: boolean\n        default: false/);
  assert.match(workflow, /stable:\n[\s\S]*?type: boolean\n        default: false/);
  assert.match(workflow, /- name: Refuse a stable tag without publication\n        if: \$\{\{ inputs.stable && !inputs.publish \}\}\n        run: \|\n[^\n]*\n          exit 1\n/);
  assert.match(workflow, /^permissions:\n  contents: read\n\n/m);
  const validate = workflow.slice(workflow.indexOf('\n  validate:\n'), workflow.indexOf('\n  publish:\n'));
  const publish = workflow.slice(workflow.indexOf('\n  publish:\n'));
  assert.ok(validate.length > 0 && publish.length > 0);
  assert.ok(validate.indexOf('Refuse a stable tag') < validate.indexOf('actions/checkout'), 'Refusal runs first');
  // With no code-level refusal, reviewer approval on the environment is the release gate.
  assert.ok(publish.indexOf('required_reviewers') < publish.indexOf('docker login'));
  for (const write of ['packages: write', 'docker login', 'docker push', 'push: true', 'secrets.']) {
    assert.ok(!validate.includes(write), `validate must not contain ${write}`);
  }
  // Publication promotes the scanned archive; it never builds another image.
  assert.match(publish, /needs: validate\n    if: \$\{\{ inputs.publish && needs.validate.result == 'success' \}\}/);
  assert.match(publish, /environment: ghcr-release/);
  assert.match(publish, /select\(\.type == "required_reviewers"\)/);
  for (const build of ['build-push-action', 'docker build', 'buildx build', 'Dockerfile', 'npm ', 'setup-buildx']) {
    assert.ok(!publish.includes(build), `publish must not contain ${build}`);
  }
  assert.ok(publish.indexOf('sha256sum --check --strict') < publish.indexOf('docker load'));
  assert.ok(publish.indexOf('image-digest.mjs archive') < publish.indexOf('docker load'));
  assert.ok(publish.indexOf('docker push') < publish.indexOf('image-digest.mjs registry'));
  assert.match(validate, /if: \$\{\{ success\(\) && inputs.publish \}\}\n        uses: actions\/upload-artifact@/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /gitleaks git/);
  assert.match(workflow, /secrets-image-layers.json/);
  assert.match(workflow, /vulnerability-gate.mjs/);
  assert.match(workflow, /node scripts\/install-gateway-policy\.mjs "\$fixture"\n          echo "Z2M_GATEWAY_FIXTURE=\$fixture"/);
  assert.ok(validate.indexOf('Z2M_GATEWAY_FIXTURE=') < validate.indexOf('run: node --test'), 'Capacity fixture precedes tests');
  assert.match(workflow, /run: node --test/);
  assert.match(read('scripts/container-smoke.mjs'), /'--network', 'none'/);
});
