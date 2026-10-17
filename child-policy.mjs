// Both retained-session and per-request gateway paths use spawnCommand.
// The runtime image has no shell, so the gateway's --stdio value is only a
// fixed name. This launcher starts the application directly, shell: false,
// and each tracked process is one application child.
export const APPLICATION = 'z2m-application';
export const APPLICATION_ENTRY = '/opt/zigbee2mqtt-mcp/dist/index.js';

// Capacity is a refusal, not a failure: gateway integrations recognise this
// code, answer 503, and let every other spawn error behave as upstream does.
export const CHILD_CAPACITY = 'Z2M_GATEWAY_CHILD_CAPACITY';
export const RETRY_AFTER_SECONDS = 60;

export function createChildLimiter(limit = 4) {
  let active = 0;
  return (spawn, ...args) => {
    if (active >= limit) throw Object.assign(new Error('Gateway child capacity reached'), { code: CHILD_CAPACITY });
    active++;
    let released = false;
    const release = () => {
      if (!released) { released = true; active--; }
    };
    try {
      const child = spawn(...args);
      child.once('exit', release);
      child.once('error', release);
      return child;
    } catch (error) {
      release();
      throw error;
    }
  };
}

const REFUSAL = 'Gateway session capacity reached';

export const atCapacity = (error) => error?.code === CHILD_CAPACITY;

// A new session refused at capacity: fixed text, no values, and a retry hint.
// Returns false, sending nothing, for any other error.
export function refuseAtCapacity(error, res) {
  if (!atCapacity(error)) return false;
  if (!res.headersSent) {
    res.status(503).set('Retry-After', String(RETRY_AFTER_SECONDS)).type('text/plain').send(REFUSAL);
  }
  return true;
}

// The same refusal for a 2026-07-28 request, whose answer is a Web Response.
export const capacityResponse = () => new Response(REFUSAL, {
  status: 503,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': String(RETRY_AFTER_SECONDS) },
});

// A stateful session's transport is connected before its child starts. When
// the child is refused, close that transport: it never got a session id, so
// nothing registered it, and nothing else will.
export function closeOnRefusal(transport, start) {
  try {
    return start();
  } catch (error) {
    if (atCapacity(error)) void transport.close().catch(() => {});
    throw error;
  }
}

// The gateway bearer credential is not an MQTT child credential: build the
// child environment without it instead of unsetting it after start.
export function applicationEnv(env, sequence) {
  const prefix = env.Z2M_CONTAINER_CLIENT_PREFIX;
  if (!prefix) throw new Error('Container entrypoint must set a client prefix');
  const child = { ...env, Z2M_MQTT_CLIENT_ID: `${prefix}-${sequence}` };
  delete child.SUPERGATEWAY_API_KEY;
  return child;
}

export function createApplicationLauncher(env = process.env, execPath = process.execPath) {
  let sequence = 0;
  return (spawn, command, options) => {
    if (command !== APPLICATION) throw new Error('Unexpected gateway child command');
    return spawn(execPath, [APPLICATION_ENTRY], { ...options, shell: false, env: applicationEnv(env, ++sequence) });
  };
}

const limited = createChildLimiter();
const launch = createApplicationLauncher();
export const boundedSpawn = (spawn, ...args) => limited(launch, spawn, ...args);
