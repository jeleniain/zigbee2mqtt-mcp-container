import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../dependencies/trim-runtime.mjs', import.meta.url));

test('runtime trim removes only reviewed non-runtime files and keeps code and licenses', () => {
  const root = mkdtempSync(join(tmpdir(), 'z2m-trim-'));
  const files = {
    removed: ['@types/node/https.d.ts', 'debug/.coveralls.yml', 'readable-stream/README.md',
      'concat-stream/node_modules/readable-stream/README.md', 'zod/src/v4/classic/tests/fixture.ts'],
    kept: ['debug/LICENSE', 'debug/src/index.js', 'readable-stream/LICENSE', 'readable-stream/lib/ours/index.js',
      'concat-stream/README.md', 'mqtt/README.md', 'zod/src/v4/classic/schemas.ts', 'zod/LICENSE'],
  };
  try {
    for (const file of [...files.removed, ...files.kept]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), 'synthetic');
    }
    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const file of files.removed) assert.equal(existsSync(join(root, file)), false, file);
    for (const file of files.kept) assert.equal(existsSync(join(root, file)), true, file);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
