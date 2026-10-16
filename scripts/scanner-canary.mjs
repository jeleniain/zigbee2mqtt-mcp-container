import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  writeFileSync(join(directory, 'payload', 'credential.txt'), `github_token=${canary}\n`);
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
  const result = spawnSync(process.execPath, ['scripts/scan-image-layers.mjs', archive, report], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'Deleted-layer canary must fail the scanner');
  const findings = JSON.parse(readFileSync(report, 'utf8'));
  assert.ok(findings.some((finding) => finding.RuleID === 'github-pat'));
  assert.ok(!readFileSync(report, 'utf8').includes(canary), 'Scanner reports must redact secret values');
  console.log('Extensionless image-layer and deleted-file secret detection passed; report is redacted.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
