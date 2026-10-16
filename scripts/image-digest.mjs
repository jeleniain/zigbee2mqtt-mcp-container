import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The config digest names the image config, which lists every layer diff ID.
// Equal config digests mean the published image is the scanned image, not a
// rebuild, independent of local image store IDs or registry compression.
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function archiveConfigDigest(manifestJson) {
  const manifest = JSON.parse(manifestJson);
  assert.ok(Array.isArray(manifest) && manifest.length === 1, 'Archive must contain exactly one image');
  const match = /^(?:blobs\/sha256\/([0-9a-f]{64})|([0-9a-f]{64})\.json)$/.exec(manifest[0].Config ?? '');
  assert.ok(match, 'Unrecognized archive config path');
  return `sha256:${match[1] ?? match[2]}`;
}

const INDEX_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];

// Returns the config digest, or the platform manifest digest to fetch next.
export function registryStep(raw, platform = { os: 'linux', architecture: 'amd64' }) {
  const document = JSON.parse(raw);
  if (INDEX_TYPES.includes(document.mediaType)) {
    const images = (document.manifests ?? []).filter((entry) =>
      entry.platform?.os === platform.os && entry.platform?.architecture === platform.architecture);
    assert.equal(images.length, 1, 'Index must contain exactly one linux/amd64 image');
    assert.match(images[0].digest, DIGEST);
    return { manifest: images[0].digest };
  }
  assert.match(document.config?.digest ?? '', DIGEST, 'Manifest has no config digest');
  return { config: document.config.digest };
}

function registryConfigDigest(reference) {
  const inspect = (ref) => execFileSync('docker', ['buildx', 'imagetools', 'inspect', '--raw', ref], { encoding: 'utf8' });
  let step = registryStep(inspect(reference));
  if (step.manifest) step = registryStep(inspect(`${reference.replace(/[@:][^/@:]+$/, '')}@${step.manifest}`));
  assert.ok(step.config, 'Nested index is not supported');
  return step.config;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, target] = process.argv.slice(2);
  assert.ok(target, 'Usage: node image-digest.mjs archive <docker-save.tar> | registry <reference>');
  if (mode === 'archive') console.log(archiveConfigDigest(execFileSync('tar', ['-xOf', target, 'manifest.json'], { encoding: 'utf8' })));
  else if (mode === 'registry') console.log(registryConfigDigest(target));
  else throw new Error('Unknown mode');
}
