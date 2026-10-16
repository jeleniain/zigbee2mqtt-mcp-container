import assert from 'node:assert/strict';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The source archives remain immutable; only these reviewed dependency pins change.
const profiles = {
  'zigbee2mqtt-mcp': {
    version: '0.7.0',
    dependencies: { '@modelcontextprotocol/sdk': '1.32.0' },
    overrides: { 'proxy-addr': '2.0.8' },
  },
  supergateway: {
    version: '4.2.0',
    dependencies: {
      '@modelcontextprotocol/client': '2.3.0',
      '@modelcontextprotocol/node': '2.1.1',
      '@modelcontextprotocol/sdk': '1.32.0',
      '@modelcontextprotocol/server': '2.3.0',
    },
    overrides: { 'proxy-addr': '2.0.8' },
  },
};

const [name, directory, mode] = process.argv.slice(2);
const profile = profiles[name];
assert.ok(profile, 'Unknown dependency overlay');
assert.ok(directory, 'Upstream source directory is required');
assert.ok(mode === undefined || mode === '--generate', 'Unknown overlay mode');
const manifestPath = resolve(directory, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
assert.equal(manifest.name, name);
assert.equal(manifest.version, profile.version);
Object.assign(manifest.dependencies, profile.dependencies);
manifest.overrides = { ...manifest.overrides, ...profile.overrides };
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
if (mode !== '--generate') {
  copyFileSync(fileURLToPath(new URL(`./${name}.package-lock.json`, import.meta.url)), resolve(directory, 'package-lock.json'));
}
