import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { spawn as realSpawn } from 'node:child_process';
import {
  APPLICATION, APPLICATION_ENTRY, CHILD_CAPACITY, capacityResponse, closeOnRefusal, createApplicationLauncher,
  createChildLimiter, refuseAtCapacity,
} from '../child-policy.mjs';

const env = () => ({ SUPERGATEWAY_API_KEY: 'test-only-not-a-real-secret', Z2M_CONTAINER_CLIENT_PREFIX: 'z2m-mcp-fixture', PATH: '/usr/bin' });

test('launcher starts only the fixed application without a shell or the gateway credential', () => {
  const calls = [];
  const spawn = (...args) => { calls.push(args); return new EventEmitter(); };
  const source = env();
  const launch = createApplicationLauncher(source, '/usr/local/bin/node');
  launch(spawn, APPLICATION, { shell: true, detached: true });
  launch(spawn, APPLICATION, { shell: true, detached: true });
  assert.equal(calls.length, 2);
  const [[command, args, options], [, , second]] = calls;
  assert.equal(command, '/usr/local/bin/node');
  assert.deepEqual(args, [APPLICATION_ENTRY]);
  assert.equal(options.shell, false);
  assert.equal(options.detached, true);
  assert.equal(options.env.SUPERGATEWAY_API_KEY, undefined);
  assert.equal(options.env.PATH, '/usr/bin');
  assert.equal(options.env.Z2M_MQTT_CLIENT_ID, 'z2m-mcp-fixture-1');
  assert.equal(second.env.Z2M_MQTT_CLIENT_ID, 'z2m-mcp-fixture-2');
  assert.equal(source.SUPERGATEWAY_API_KEY, 'test-only-not-a-real-secret', 'Gateway keeps its own key');
});

test('launcher refuses other commands and a missing client prefix before spawning', () => {
  let spawned = 0;
  const spawn = () => { spawned++; return new EventEmitter(); };
  const launch = createApplicationLauncher(env());
  for (const command of ['exec /bin/sh -c id', `${APPLICATION} --extra`, { command: 'node', args: [] }]) {
    assert.throws(() => launch(spawn, command, { shell: true }), /Unexpected gateway child command/);
  }
  const noPrefix = env();
  delete noPrefix.Z2M_CONTAINER_CLIENT_PREFIX;
  assert.throws(() => createApplicationLauncher(noPrefix)(spawn, APPLICATION, {}), /client prefix/);
  assert.equal(spawned, 0);
});

test('real child process environment has no gateway credential', async () => {
  // Same launcher options, with the fixed entry replaced by a probe for this host test.
  const launch = createApplicationLauncher(env(), process.execPath);
  const probe = (command, args, options) => realSpawn(command, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], options);
  const child = launch(probe, APPLICATION, { shell: true, detached: false });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0);
  const observed = JSON.parse(output);
  assert.equal(observed.SUPERGATEWAY_API_KEY, undefined);
  assert.equal(observed.Z2M_MQTT_CLIENT_ID, 'z2m-mcp-fixture-1');
});

test('child admission is bounded before spawning, and exit restores capacity', () => {
  const admit = createChildLimiter();
  const children = [];
  const spawn = () => { const child = new EventEmitter(); children.push(child); return child; };
  for (let index = 0; index < 4; index++) admit(spawn);
  assert.throws(() => admit(spawn), /capacity/);
  assert.equal(children.length, 4);
  children[0].emit('exit', 0);
  admit(spawn);
  children[0].emit('error', new Error('already released'));
  assert.throws(() => admit(spawn), /capacity/, 'Multiple terminal events must not release twice');
});

test('synchronous and asynchronous spawn failures restore capacity', () => {
  const admit = createChildLimiter(1);
  assert.throws(() => admit(() => { throw new Error('synthetic spawn failure'); }), /synthetic/);
  const failed = admit(() => new EventEmitter());
  failed.emit('error', new Error('synthetic async spawn failure'));
  const alive = admit(() => new EventEmitter());
  assert.throws(() => admit(() => new EventEmitter()), /capacity/);
  alive.emit('exit', 1);
  assert.doesNotThrow(() => admit(() => new EventEmitter()));
});

const capacityError = () => {
  const admit = createChildLimiter(0);
  try { admit(() => assert.fail('Refused children must not spawn')); } catch (error) { return error; }
  assert.fail('A full limiter must refuse');
};

// Records what the gateway's Express response was sent.
const response = (headersSent = false) => {
  const sent = { headers: {}, headersSent };
  const res = {
    get headersSent() { return sent.headersSent; },
    status(code) { sent.status = code; return res; },
    set(name, value) { sent.headers[name.toLowerCase()] = value; return res; },
    type(type) { sent.type = type; return res; },
    send(body) { sent.body = body; sent.headersSent = true; return res; },
  };
  return { res, sent };
};

test('capacity is a distinguishable refusal answered 503 with a fixed body and retry hint', async () => {
  const error = capacityError();
  assert.equal(error.code, CHILD_CAPACITY);
  const { res, sent } = response();
  assert.equal(refuseAtCapacity(error, res), true);
  assert.deepEqual(sent, {
    headers: { 'retry-after': '60' }, headersSent: true, status: 503,
    type: 'text/plain', body: 'Gateway session capacity reached',
  });
  const web = capacityResponse();
  assert.equal(web.status, 503);
  assert.equal(web.headers.get('retry-after'), '60');
  assert.equal(await web.text(), 'Gateway session capacity reached');
});

test('other errors are not refusals and send nothing', () => {
  const spawnFailure = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  for (const error of [spawnFailure, new Error('Gateway child capacity reached'), undefined, null, 'text']) {
    const { res, sent } = response();
    assert.equal(refuseAtCapacity(error, res), false);
    assert.deepEqual(sent, { headers: {}, headersSent: false });
  }
  const { res, sent } = response(true);
  assert.equal(refuseAtCapacity(capacityError(), res), true, 'Still handled when a response already started');
  assert.equal(sent.status, undefined, 'But nothing more is written to it');
});

test('a refused session closes only its own unregistered transport and rethrows', () => {
  const transport = () => {
    const state = { closed: 0 };
    state.transport = { close: async () => { state.closed++; } };
    return state;
  };
  const refused = transport();
  const error = capacityError();
  assert.throws(() => closeOnRefusal(refused.transport, () => { throw error; }), (thrown) => thrown === error);
  assert.equal(refused.closed, 1);
  const failed = transport();
  assert.throws(() => closeOnRefusal(failed.transport, () => { throw new Error('synthetic spawn failure'); }), /synthetic/);
  assert.equal(failed.closed, 0, 'Unrelated failures keep upstream behaviour');
  const started = transport();
  assert.equal(closeOnRefusal(started.transport, () => 'peer'), 'peer');
  assert.equal(started.closed, 0);
});
