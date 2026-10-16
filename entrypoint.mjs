import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { allowedHosts } from './http-policy.mjs';

export const tools = Object.freeze([
  'z2m_connection_status',
  'z2m_list_devices',
  'z2m_get_device',
  'z2m_health_report',
  'z2m_list_groups',
  'z2m_get_logs',
]);

export function configure(env, args = []) {
  if (args.length) throw new Error('Runtime command overrides are not supported');
  allowedHosts(env);
  const key = env.SUPERGATEWAY_API_KEY?.trim();
  if (!key || !/^[\x21-\x7e]+$/.test(key)) {
    throw new Error('SUPERGATEWAY_API_KEY must contain a nonempty printable ASCII key without spaces');
  }
  if (env.SUPERGATEWAY_API_KEY_FILE !== undefined) {
    throw new Error('Key files are not supported; use SUPERGATEWAY_API_KEY');
  }
  if (env.Z2M_MQTT_CLIENT_ID !== undefined) {
    throw new Error('Fixed Z2M_MQTT_CLIENT_ID is not supported with per-session children');
  }
  const raw = env.Z2M_MQTT_URL;
  let broker;
  try {
    broker = new URL(raw);
  } catch {
    throw new Error('Z2M_MQTT_URL must be a valid broker URL');
  }
  if (!['mqtts:', 'wss:'].includes(broker.protocol) || !broker.hostname) {
    throw new Error('Z2M_MQTT_URL must use encrypted mqtts or wss with a hostname');
  }
  if (broker.username || broker.password || /^[^:]+:\/\/[^/?#]*@/.test(raw)) {
    throw new Error('Use Z2M_MQTT_USERNAME and Z2M_MQTT_PASSWORD, not URL userinfo');
  }
  env.SUPERGATEWAY_API_KEY = key;
  env.Z2M_WRITE_MODE = 'off';
  env.Z2M_MQTT_REJECT_UNAUTHORIZED = 'true';
  env.Z2M_LOG_LEVEL = 'silent';
  // Different container starts get different prefixes, even with identical hostnames.
  env.Z2M_CONTAINER_CLIENT_PREFIX = `z2m-mcp-${randomUUID()}`;
  return [
    '--stdio', 'exec /bin/sh /opt/container/child.sh',
    '--outputTransport', 'streamableHttp',
    '--host', '0.0.0.0',
    '--port', '8000',
    '--streamableHttpPath', '/mcp',
    '--stateful',
    '--sessionTimeout', '1800000',
    '--logLevel', 'none',
    ...tools.flatMap((name) => ['--tools', name]),
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const args = configure(process.env, process.argv.slice(2));
    const gateway = '/opt/supergateway/dist/index.js';
    process.argv = [process.execPath, gateway, ...args];
    // Upstream shuts down on stdin close. Detached Docker closes fd 0; this
    // HTTP-only gateway needs no external stdin, so keep a private stream open.
    Object.defineProperty(process, 'stdin', { value: new PassThrough() });
    // No supervisor child: the gateway owns PID 1 and its normal signal handlers.
    await import(pathToFileURL(gateway).href);
  } catch {
    // Never echo environment values, URLs, or upstream exception text.
    console.error('Container startup refused: invalid configuration or unavailable gateway');
    process.exitCode = 1;
  }
}
