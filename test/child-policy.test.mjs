import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createChildLimiter } from '../child-policy.mjs';

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
