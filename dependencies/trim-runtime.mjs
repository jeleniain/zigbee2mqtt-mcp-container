import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Omit published test fixtures, upstream coverage credentials, and docs that
// Node never loads before COPY. Keep licenses, exported modules and JavaScript.
function trim(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    // Compile-time TypeScript declarations only; @types/node documents public
    // certificate key pins that image secret scanning reports.
    if (entry.name === '@types') {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (entry.name === 'debug') rmSync(join(path, '.coveralls.yml'), { force: true });
    // Maintainer lists include public release GPG key fingerprints.
    if (entry.name === 'readable-stream') rmSync(join(path, 'README.md'), { force: true });
    if (entry.name === 'zod') {
      for (const variant of ['mini', 'classic']) {
        rmSync(join(path, 'src', 'v4', variant, 'tests'), { recursive: true, force: true });
      }
    }
    trim(path);
  }
}
for (const directory of process.argv.slice(2)) trim(directory);
