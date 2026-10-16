import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveConfigDigest, registryStep } from '../scripts/image-digest.mjs';

const hex = 'a'.repeat(64);
const other = 'b'.repeat(64);

test('archive config digest is read from OCI and legacy docker save layouts', () => {
  assert.equal(archiveConfigDigest(JSON.stringify([{ Config: `blobs/sha256/${hex}` }])), `sha256:${hex}`);
  assert.equal(archiveConfigDigest(JSON.stringify([{ Config: `${hex}.json` }])), `sha256:${hex}`);
  for (const manifest of [[], [{ Config: `blobs/sha256/${hex}` }, { Config: `blobs/sha256/${other}` }], [{ Config: '../etc/passwd' }], [{}]]) {
    assert.throws(() => archiveConfigDigest(JSON.stringify(manifest)));
  }
});

test('registry manifests resolve to one linux/amd64 config digest', () => {
  const manifest = { mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: `sha256:${hex}` } };
  assert.deepEqual(registryStep(JSON.stringify(manifest)), { config: `sha256:${hex}` });
  const index = (manifests) => JSON.stringify({ mediaType: 'application/vnd.oci.image.index.v1+json', manifests });
  const amd64 = { digest: `sha256:${other}`, platform: { os: 'linux', architecture: 'amd64' } };
  const attestation = { digest: `sha256:${hex}`, platform: { os: 'unknown', architecture: 'unknown' } };
  assert.deepEqual(registryStep(index([amd64, attestation])), { manifest: `sha256:${other}` });
  assert.throws(() => registryStep(index([attestation])), /exactly one/);
  assert.throws(() => registryStep(index([amd64, amd64])), /exactly one/);
  assert.throws(() => registryStep(JSON.stringify({ mediaType: manifest.mediaType, config: {} })), /config digest/);
});
