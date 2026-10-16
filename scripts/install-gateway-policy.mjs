import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
assert.ok(root, 'Provide the pinned gateway build directory');
// Refuse to apply this compiled-code integration to a changed upstream source.
const source = readFileSync(join(root, 'src/lib/streamableHttpApp.ts'));
assert.equal(createHash('sha256').update(source).digest('hex'),
  '46ea5f961701e6e9985affb479b4edc600bf12b0b186717fd12e115caad0b12c');
const path = join(root, 'dist/lib/streamableHttpApp.js');
const compiled = readFileSync(path, 'utf8');
const marker = 'const app = express();';
assert.equal(compiled.split(marker).length, 2, 'Gateway middleware integration must match exactly once');
writeFileSync(path, "import { createHttpPolicy } from '/opt/container/http-policy.mjs';\n" +
  compiled.replace(marker, `${marker}\n    app.use(createHttpPolicy());`));

const childSource = readFileSync(join(root, 'src/lib/childCommand.ts'));
assert.equal(createHash('sha256').update(childSource).digest('hex'),
  'aaa7e0c9489f8e540f2237b062cec337b855c80b1d62f43c85ae3d748d87f2e2');
const childPath = join(root, 'dist/lib/childCommand.js');
const childCompiled = readFileSync(childPath, 'utf8');
const childMarker = 'export function spawnCommand(spawn, command, options) {';
assert.equal(childCompiled.split(childMarker).length, 2, 'Shared child spawn integration must match exactly once');
writeFileSync(childPath, "import { boundedSpawn } from '/opt/container/child-policy.mjs';\n" +
  childCompiled.replace(childMarker, 'export function spawnCommand(unboundedSpawn, command, options) {\n' +
    '    const spawn = (...args) => boundedSpawn(unboundedSpawn, ...args);'));
