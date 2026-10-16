import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REVISION = '508a9215f78672f43bd64571d38c3ae2342ea040';
const fingerprints = {
  'client.ts': 'c3de46157ba14626a169e632efb7c939c1c0af10',
  'tools.ts': '1ae3b5485dbc5124f7d5a9aba2b8880c69cfa81f',
  'index.ts': '4fa56dd0eb9c4ebe52db297c0fe54a30ff67abe6',
  'render.ts': 'e39c1f7fb8987a188c24cc5720030196955d1341',
};
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Reviewed source anchor mismatch');
  return source.replace(before, after);
}
function replaceSection(source, start, end, replacement) {
  const begin = source.indexOf(start), finish = source.indexOf(end, begin);
  if (begin < 0 || finish < 0 || source.indexOf(start, begin + 1) >= 0) throw new Error('Reviewed source section mismatch');
  return source.slice(0, begin) + replacement + source.slice(finish);
}
export function patchSource(root) {
  const sources = {};
  // Verify every original input before writing any change. Not idempotent: a
  // rerun or an upstream revision change must fail closed and be reviewed.
  for (const [name, expected] of Object.entries(fingerprints)) {
    const source = readFileSync(resolve(root, 'src', name), 'utf8').replaceAll('\r\n', '\n');
    const digest = createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
    if (digest !== expected) throw new Error(`Source assertion failed for ${name} at reviewed revision ${REVISION}`);
    sources[name] = source;
  }
  const modulePath = resolve(root, 'src/security-boundary.ts');
  if (existsSync(modulePath)) throw new Error('Unexpected existing security boundary');
  let client = 'import { intake } from "./security-boundary.js";\n' + sources['client.ts'];
  client = replaceSection(client, '  handleMessage(topic: string, payload: Buffer): void {', '\n  /**\n   * Renames and removals',
    '  handleMessage(topic: string, payload: Buffer): void {\n    intake(this, topic, payload);\n  }\n');
  client = replaceSection(client, '  async request<T = unknown>(', '\n  private async awaitBridgeRefresh',
    '  async request<T = unknown>(_subTopic: string, _payload: Record<string, unknown> = {}, _timeoutMs?: number): Promise<T> {\n    throw new Error("MQTT publishing disabled by container policy");\n  }\n');
  client = replaceSection(client, '  async publish(topic: string, payload: unknown): Promise<void> {', '\n  // ----------------------------------------------------------------- accessors',
    '  async publish(_topic: string, _payload: unknown): Promise<void> {\n    throw new Error("MQTT publishing disabled by container policy");\n  }\n');
  let index = 'import { hardenTools } from "./security-boundary.js";\n' + sources['index.ts'].replace('#!/usr/bin/env node\n', '');
  index = replaceOnce(index, 'const tools = selectTools(config.writeMode);', 'const tools = hardenTools(selectTools("off"));');
  index = replaceOnce(index, 'text: configError }', 'text: "Server configuration unavailable" }');
  index = replaceOnce(index, "`Unknown tool '${request.params.name}'. Available tools: ${known}. ` +\n              `Write mode is '${config.writeMode}'; raise Z2M_WRITE_MODE to expose more.`", '"Unknown or disabled tool"');
  index = index.replaceAll('console.error(`[zigbee2mqtt-mcp] unhandled rejection: ${String(reason)}`);', 'console.error("[zigbee2mqtt-mcp] unhandled rejection");')
    .replaceAll('console.error(`[zigbee2mqtt-mcp] uncaught exception: ${error.message}`);', 'console.error("[zigbee2mqtt-mcp] uncaught exception");')
    .replaceAll('console.error(`[zigbee2mqtt-mcp] fatal: ${(error as Error).message}`);', 'console.error("[zigbee2mqtt-mcp] fatal error");');
  const render = replaceOnce(sources['render.ts'], 'return `${toolName} failed: ${scrubSecrets((error as Error).message, config)}`;', 'return "Tool request failed or was refused by container policy";');
  const boundary = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'security-boundary.mjs'), 'utf8');
  writeFileSync(modulePath, '// @ts-nocheck\n' + boundary);
  for (const [name, source] of Object.entries({ 'client.ts': client, 'index.ts': index, 'render.ts': render })) writeFileSync(resolve(root, 'src', name), source);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node patch-upstream-security.mjs <extracted-upstream-root>');
  patchSource(resolve(process.argv[2]));
}
