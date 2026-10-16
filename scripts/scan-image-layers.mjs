import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Docker's OCI-compatible save uses extensionless blobs. Gitleaks does not
// recurse into those automatically: give each referenced layer a .tar suffix.
const [archive, report] = process.argv.slice(2);
assert.ok(archive && report, 'Provide docker-save archive and report path');
const manifest = spawnSync('tar', ['-xOf', archive, 'manifest.json'], { encoding: 'utf8' });
assert.equal(manifest.status, 0, manifest.stderr);
const images = JSON.parse(manifest.stdout);
assert.ok(Array.isArray(images) && images.length > 0);
const directory = mkdtempSync(join(tmpdir(), 'z2m-image-secrets-'));
try {
  let count = 0;
  for (const image of images) {
    assert.ok(typeof image.Config === 'string' && Array.isArray(image.Layers) && image.Layers.length > 0);
    for (const [index, member] of [image.Config, ...image.Layers].entries()) {
      assert.ok(typeof member === 'string' && /^[a-zA-Z0-9_./-]+$/.test(member));
      assert.ok(!member.startsWith('-') && !member.startsWith('/') && !member.split('/').includes('..'));
      const target = join(directory, `${count++}${index === 0 ? '.json' : '.tar'}`);
      const fd = openSync(target, 'wx');
      try {
        const extract = spawnSync('tar', ['-xOf', archive, member], { stdio: ['ignore', fd, 'pipe'] });
        assert.equal(extract.status, 0, extract.stderr?.toString());
      } finally { closeSync(fd); }
    }
  }
  console.log(`Scanning ${count} image config/layer entries independently, including whiteouted files.`);
  const scan = spawnSync('gitleaks', ['dir', directory, '--redact=100', '--ignore-gitleaks-allow',
    '--max-archive-depth', '4', '--max-decode-depth', '3', '--report-format', 'json', '--report-path', report],
  { stdio: 'inherit' });
  assert.equal(scan.status, 0, 'Image secret scan failed');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
