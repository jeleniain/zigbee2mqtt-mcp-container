// Both retained-session and per-request gateway paths use spawnCommand.
// The runtime image has no shell, so the gateway's --stdio value is only a
// fixed name. This launcher starts the application directly, shell: false,
// and each tracked process is one application child.
export const APPLICATION = 'z2m-application';
export const APPLICATION_ENTRY = '/opt/zigbee2mqtt-mcp/dist/index.js';

export function createChildLimiter(limit = 4) {
  let active = 0;
  return (spawn, ...args) => {
    if (active >= limit) throw new Error('Gateway child capacity reached');
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
