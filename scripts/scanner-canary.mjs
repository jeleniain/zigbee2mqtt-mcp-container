import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Synthetic only: prove a secret hidden in an extensionless layer is found even
// when a subsequent layer whiteouts it. Never put the canary in the real image.
const directory = mkdtempSync(join(tmpdir(), 'z2m-secret-canary-'));
const run = (...args) => {
  const result = spawnSync('tar', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
try {
  mkdirSync(join(directory, 'blobs'));
  mkdirSync(join(directory, 'payload'));
  mkdirSync(join(directory, 'removed'));
  const canary = ['ghp_', 'A7xQ9mR2vK6pT4nW8yB3dF5hJ1sL0cE9uZ6a'].join('');
  const headerDirectory = join(directory, 'payload', 'usr/local/include/node');
  mkdirSync(headerDirectory, { recursive: true });
  const header = join(headerDirectory, 'v8-internal.h');
  writeFileSync(header, 'const int kApiTaggedSize = kApiSystemPointerSize;\n');
  // A dangling compressed symlink must not cause a decompression error.
  symlinkSync('absent.gz', join(directory, 'payload', 'alias.gz'));
  writeFileSync(join(directory, 'removed', '.wh.credential.txt'), '');
  run('-cf', join(directory, 'blobs', 'first'), '-C', join(directory, 'payload'), '.');
  run('-cf', join(directory, 'blobs', 'second'), '-C', join(directory, 'removed'), '.');
  writeFileSync(join(directory, 'config.json'), '{}');
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify([
    { Config: 'config.json', Layers: ['blobs/first', 'blobs/second'] },
  ]));
  const archive = join(directory, 'image.tar');
  run('-cf', archive, '-C', directory, 'manifest.json', 'config.json', 'blobs');
  const report = join(directory, 'report.json');
  const clean = spawnSync(process.execPath, ['scripts/scan-image-layers.mjs', archive, report], { encoding: 'utf8' });
  assert.equal(clean.status, 0, 'Exact public constant and compressed symlink must scan cleanly');
  writeFileSync(join(directory, 'payload', 'credential.txt'), `github_token=${canary}\n`);
  writeFileSync(join(directory, 'payload', 'nested.txt.gz'), gzipSync(`github_token=${canary}\n`));
  writeFileSync(header, `const int kApiTaggedSize = kApiSystemPointerSize;\ngithub_token=${canary}\n`);
  run('-cf', join(directory, 'blobs', 'first'), '-C', join(directory, 'payload'), '.');
  run('-cf', archive, '-C', directory, 'manifest.json', 'config.json', 'blobs');
  const result = spawnSync(process.execPath, ['scripts/scan-image-layers.mjs', archive, report], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'Deleted-layer canary must fail the scanner');
  const findings = JSON.parse(readFileSync(report, 'utf8'));
  assert.ok(findings.some((finding) => finding.RuleID === 'github-pat'));
  for (const path of ['credential.txt', 'nested.txt.gz', 'v8-internal.h']) {
    assert.ok(findings.some((finding) => finding.File.includes(path)), `Canary not detected in ${path}`);
  }
  assert.ok(!/Scanner reported an analysis error/.test(result.stderr), 'Canary scan must have complete coverage');
  assert.ok(!readFileSync(report, 'utf8').includes(canary), 'Scanner reports must redact secret values');
  console.log('Deleted-layer, nested gzip, header-path canaries and symlink handling passed; report is redacted.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
