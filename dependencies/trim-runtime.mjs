import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Omit published test fixtures and upstream coverage credentials before COPY.
// Keep licenses, exported modules, JavaScript and declarations unchanged.
function trim(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.name === 'debug') rmSync(join(path, '.coveralls.yml'), { force: true });
    if (entry.name === 'zod') {
      for (const variant of ['mini', 'classic']) {
        rmSync(join(path, 'src', 'v4', variant, 'tests'), { recursive: true, force: true });
      }
    }
    trim(path);
  }
}
for (const directory of process.argv.slice(2)) trim(directory);
