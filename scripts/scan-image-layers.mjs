import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never extract archive links: they can point outside the scan tree and gzip
// symlinks confuse archive scanners. GNU tar --to-command supplies regular
// files only. Link names/targets are still scanned through the tar listing.
const [archive, report, filesystem] = process.argv.slice(2);
assert.ok(archive && report, 'Provide docker-save archive and report path');
const manifest = spawnSync('tar', ['-xOf', archive, 'manifest.json'], { encoding: 'utf8' });
assert.equal(manifest.status, 0, manifest.stderr);
const images = JSON.parse(manifest.stdout);
assert.ok(Array.isArray(images) && images.length > 0);
const directory = mkdtempSync(join(tmpdir(), 'z2m-image-secrets-'));
const extractRegular = (source, destination) => {
  mkdirSync(destination);
  const listing = openSync(join(destination, 'archive-members.txt'), 'wx');
  try {
    const result = spawnSync('tar', ['-tvf', source], { stdio: ['ignore', listing, 'pipe'] });
    assert.equal(result.status, 0, 'Cannot list image archive members');
  } finally { closeSync(listing); }
  const extract = spawnSync('tar', ['-xf', source, '--no-ignore-command-error', '--to-command', `
    set -euC
    case "$TAR_FILENAME" in /*|..|../*|*/../*|*/..) exit 1;; esac
    mkdir -p -- "$SCAN_DIRECTORY/$(dirname -- "$TAR_FILENAME")"
    cat > "$SCAN_DIRECTORY/$TAR_FILENAME"
  `], { env: { ...process.env, SCAN_DIRECTORY: destination }, encoding: 'utf8' });
  assert.equal(extract.status, 0, 'Cannot materialize image regular files');
};
try {
  let count = 0;
  for (const image of images) {
    assert.ok(typeof image.Config === 'string' && Array.isArray(image.Layers) && image.Layers.length > 0);
    for (const [index, member] of [image.Config, ...image.Layers].entries()) {
      assert.ok(typeof member === 'string' && /^[a-zA-Z0-9_./-]+$/.test(member));
      assert.ok(!member.startsWith('-') && !member.startsWith('/') && !member.split('/').includes('..'));
      const number = count++;
      const target = join(directory, `${number}${index === 0 ? '.json' : '.tar'}`);
      const fd = openSync(target, 'wx');
      try {
        const extract = spawnSync('tar', ['-xOf', archive, member], { stdio: ['ignore', fd, 'pipe'] });
        assert.equal(extract.status, 0, extract.stderr?.toString());
      } finally { closeSync(fd); }
      if (index !== 0) {
        extractRegular(target, join(directory, `layer-${number}`));
        rmSync(target);
      }
    }
  }
  if (filesystem) extractRegular(filesystem, join(directory, 'final-filesystem'));
  console.log(`Scanning ${count} image config/layer entries independently, including whiteouted files; final filesystem: ${Boolean(filesystem)}.`);
  const scan = spawnSync('gitleaks', ['dir', directory, '--redact=100', '--ignore-gitleaks-allow',
    '--config', 'scripts/gitleaks-image.toml',
    '--max-archive-depth', '4', '--max-decode-depth', '3', '--report-format', 'json', '--report-path', report],
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  process.stdout.write(scan.stdout ?? '');
  process.stderr.write(scan.stderr ?? '');
  const diagnostics = `${scan.stdout ?? ''}${scan.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  assert.ok(!/\bERR\b/.test(diagnostics), 'Scanner reported an analysis error; coverage is incomplete');
  assert.equal(scan.status, 0, 'Image secret scan failed');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
