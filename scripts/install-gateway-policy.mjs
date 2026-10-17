import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
assert.ok(root, 'Provide the pinned gateway build directory');

// Refuse to apply a compiled-code integration to a changed upstream source:
// the TypeScript source must hash exactly, and every compiled anchor must
// occur exactly once, or the build fails. Nothing is written until all match.
const writes = [];
function integrate(name, sourceHash, imports, edits) {
  const source = readFileSync(join(root, `src/${name}.ts`));
  assert.equal(createHash('sha256').update(source).digest('hex'), sourceHash, `${name} source changed`);
  const path = join(root, `dist/${name}.js`);
  let compiled = readFileSync(path, 'utf8');
  for (const [marker, replacement, message] of edits) {
    assert.equal(compiled.split(marker).length, 2, message);
    compiled = compiled.replace(marker, () => replacement);
  }
  writes.push([path, `${imports}\n${compiled}`]);
}

const marker = 'const app = express();';
integrate('lib/streamableHttpApp', '46ea5f961701e6e9985affb479b4edc600bf12b0b186717fd12e115caad0b12c',
  "import { createHttpPolicy } from '/opt/container/http-policy.mjs';", [
    [marker, `${marker}\n    app.use(createHttpPolicy());`, 'Gateway middleware integration must match exactly once'],
  ]);

integrate('lib/childCommand', 'aaa7e0c9489f8e540f2237b062cec337b855c80b1d62f43c85ae3d748d87f2e2',
  "import { boundedSpawn } from '/opt/container/child-policy.mjs';", [
    ['export function spawnCommand(spawn, command, options) {',
      'export function spawnCommand(unboundedSpawn, command, options) {\n' +
      '    const spawn = (...args) => boundedSpawn(unboundedSpawn, ...args);',
      'Shared child spawn integration must match exactly once'],
  ]);

// A new stateful session over capacity is answered 503 before anything holds
// it: no session id, no child, no counted or watched response. Its connected
// transport is closed. Upstream's route has no catch, so without this the
// rejection is unhandled and Node exits with every live session.
integrate('gateways/statefulSessions', '867bfda6a7b07e434331e1b4c998dfa678effb4df6640f50edf844eb2c9e05b3',
  "import { closeOnRefusal, refuseAtCapacity } from '/opt/container/child-policy.mjs';", [
    ["            return startServer(spawn, this.source, this.children, this.logger, 'Session');",
      "            return closeOnRefusal(transport, () => startServer(spawn, this.source, this.children, this.logger, 'Session'));",
      'Stateful session start integration must match exactly once'],
    ['            transport = await this.open(res);',
      '            try {\n' +
      '                transport = await this.open(res);\n' +
      '            }\n' +
      '            catch (error) {\n' +
      '                if (refuseAtCapacity(error, res))\n' +
      '                    return;\n' +
      '                throw error;\n' +
      '            }',
      'Stateful session open integration must match exactly once'],
  ]);

// A 2026-07-28 request starts its child per request, after the SDK transport
// took the message. Upstream already catches that start failing, but answers
// 200 with an internal error (500 for a notification). At capacity, answer the
// same 503 instead; the request's own cleanup still runs as upstream's.
integrate('lib/modernRequest', '456295531aec278897cfbca068901ca56008ad5d2924144de47f320f7434821a',
  "import { atCapacity, capacityResponse } from '/opt/container/child-policy.mjs';", [
    ['        this.failed = true;',
      '        this.failed = true;\n        this.refused = atCapacity(error);',
      'Modern request failure integration must match exactly once'],
    ['    async respond(request) {',
      '    async respond(request) {\n' +
      '        const response = await this.upstreamRespond(request);\n' +
      '        if (!this.refused)\n' +
      '            return response;\n' +
      '        await response.body?.cancel();\n' +
      '        return capacityResponse();\n' +
      '    }\n' +
      '    async upstreamRespond(request) {',
      'Modern request response integration must match exactly once'],
  ]);

for (const [path, compiled] of writes) writeFileSync(path, compiled);
