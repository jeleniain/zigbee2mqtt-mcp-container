// This is a structural allowlist, not a general-purpose secret scrubber.
export const LIMITS = Object.freeze({ payloadBytes: 1048576, topicBytes: 512, devices: 1000, groups: 256, members: 256 });
export const BASELINE = Object.freeze(['z2m_connection_status', 'z2m_list_devices', 'z2m_get_device', 'z2m_health_report', 'z2m_list_groups', 'z2m_get_logs']);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
const text = (v, max = 128) => typeof v === 'string' && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : undefined;
const number = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
const bool = (v) => typeof v === 'boolean' ? v : undefined;
const choice = (v, values) => values.includes(v) ? v : undefined;
const address = (v) => typeof v === 'string' && /^0x[0-9a-f]{16}$/i.test(v) ? v : undefined;
const clean = (v) => Object.fromEntries(Object.entries(v).filter(([, value]) => value !== undefined));
const array = (v, max) => Array.isArray(v) ? v.slice(0, max) : [];
const timestamp = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : undefined;
const availability = (v) => choice(v, ['online', 'offline']);

export function projectTelemetry(value) {
  const v = object(value), update = object(v.update);
  return clean({
    linkquality: number(v.linkquality, 0, 255), battery: number(v.battery, 0, 100), battery_low: bool(v.battery_low),
    last_seen: timestamp(v.last_seen),
    update: Object.keys(update).length ? clean({ state: choice(update.state, ['available', 'idle', 'updating']),
      installed_version: number(update.installed_version), latest_version: number(update.latest_version) }) : undefined,
  });
}

function projectRawDevice(value) {
  const v = object(value), definition = object(v.definition);
  const name = text(v.friendly_name), ieee = address(v.ieee_address);
  // Names are both identifiers and MQTT suffixes. Exclude reserved routes/wildcards.
  if (!name || !ieee || /[+#]/.test(name) || name === 'bridge' || name.startsWith('bridge/') || /\/(?:set|get|availability)(?:\/|$)/.test(name)) return undefined;
  const endpoints = Object.fromEntries(Object.keys(object(v.endpoints)).filter((key) => /^\d{1,3}$/.test(key)).slice(0, 32).map((key) => [key, {}]));
  return clean({ friendly_name: name, ieee_address: ieee,
    type: choice(v.type, ['Coordinator', 'Router', 'EndDevice', 'Unknown']) ?? 'Unknown',
    network_address: number(v.network_address, 0, 65535), supported: bool(v.supported), disabled: bool(v.disabled),
    interview_state: choice(v.interview_state, ['SUCCESSFUL', 'PENDING', 'IN_PROGRESS', 'FAILED']),
    interview_completed: bool(v.interview_completed), power_source: choice(v.power_source, ['Battery', 'Mains (single phase)', 'Mains (3 phase)', 'DC Source', 'Unknown']),
    definition: clean({ model: text(definition.model), vendor: text(definition.vendor) }), endpoints,
  });
}

export function projectGroups(value) {
  return array(value, LIMITS.groups).map((item) => {
    const v = object(item);
    return clean({ id: number(v.id, 0, 65535), friendly_name: text(v.friendly_name),
      members: array(v.members, LIMITS.members).map((item) => {
        const member = object(item);
        return clean({ ieee_address: address(member.ieee_address), endpoint: number(member.endpoint, 0, 255) });
      }).filter((member) => member.ieee_address !== undefined),
    });
  }).filter((v) => v.id !== undefined);
}

function projectInfo(value) {
  const v = object(value), config = object(v.config), advanced = object(config.advanced);
  return clean({ version: text(v.version, 64), permit_join: bool(v.permit_join), restart_required: bool(v.restart_required),
    coordinator: clean({ type: choice(object(v.coordinator).type, ['zStack', 'znp', 'ember', 'EmberZNet', 'deCONZ', 'ZiGate', 'EZSP']) }),
    config: { advanced: { last_seen: choice(advanced.last_seen, ['disable', 'ISO_8601', 'ISO_8601_local', 'epoch']) ?? 'disable' },
      availability: config.availability === true || object(config.availability).enabled === true },
  });
}

function projectHealth(value, known) {
  const v = object(value), devices = object(v.devices);
  const projected = {};
  for (const ieee of known) {
    const stats = object(devices[ieee]);
    projected[ieee] = clean({ leave_count: number(stats.leave_count), network_address_changes: number(stats.network_address_changes), messages: number(stats.messages) });
  }
  return { devices: projected };
}

// Called in place of the reviewed handleMessage body. Reject before JSON parsing
// and retain only projected values, not a second raw cache.
export function intake(client, topic, payload) {
  if (typeof topic !== 'string' || Buffer.byteLength(topic) > LIMITS.topicBytes || !Buffer.isBuffer(payload) || payload.length > LIMITS.payloadBytes) return;
  const prefix = `${client.config.baseTopic}/`;
  if (!topic.startsWith(prefix)) return;
  const rest = topic.slice(prefix.length);
  const bridgeNames = ['devices', 'info', 'state', 'health', 'groups'];
  const bridgeName = rest.startsWith('bridge/') ? rest.slice(7) : undefined;
  if (bridgeName !== undefined && !bridgeNames.includes(bridgeName) && bridgeName !== 'logging') return;
  const known = new Map(array(client.bridge.get('devices'), LIMITS.devices).map((d) => [d.friendly_name, d.ieee_address]));
  const isAvailability = rest.endsWith('/availability');
  const deviceName = isAvailability ? rest.slice(0, -13) : rest;
  if (bridgeName === undefined && !known.has(deviceName)) return;
  let parsed;
  try { parsed = JSON.parse(payload.toString('utf8')); } catch { return; }
  if (bridgeName === 'logging') {
    const level = choice(object(parsed).level, ['error', 'warning', 'warn', 'info']);
    if (level) {
      client.logs.push({ received_at: new Date().toISOString(), level, message: '' });
      if (client.logs.length > 1000) client.logs.shift();
    }
    return;
  }
  if (bridgeName) {
    let value;
    switch (bridgeName) {
      case 'devices':
        // Reject an oversized list rather than silently presenting a partial estate.
        if (!Array.isArray(parsed) || parsed.length > LIMITS.devices) return;
        value = parsed.map(projectRawDevice).filter(Boolean);
        break;
      case 'groups':
        if (!Array.isArray(parsed) || parsed.length > LIMITS.groups) return;
        value = projectGroups(parsed); break;
      case 'info': value = projectInfo(parsed); break;
      case 'state': value = { state: availability(object(parsed).state) ?? 'unknown' }; break;
      case 'health': value = projectHealth(parsed, known.values()); break;
    }
    client.bridge.set(bridgeName, value);
    client.bridgeRevision++;
    if (bridgeName === 'devices') {
      const names = new Set(value.map((d) => d.friendly_name));
      for (const name of client.deviceState.keys()) if (!names.has(name)) client.deviceState.delete(name);
      for (const name of client.availability.keys()) if (!names.has(name)) client.availability.delete(name);
    }
  } else if (isAvailability) {
    const state = availability(typeof parsed === 'string' ? parsed : object(parsed).state);
    if (state) client.availability.set(deviceName, state);
  } else if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    client.deviceState.set(deviceName, projectTelemetry(parsed));
  } else return;
  client.lastMessageAt = Date.now();
}

export function projectDevice(value) {
  const v = object(value);
  return clean({ friendly_name: text(v.friendly_name), ieee_address: address(v.ieee_address),
    type: choice(v.type, ['Coordinator', 'Router', 'EndDevice', 'Unknown']), network_address: number(v.network_address, 0, 65535),
    model: text(v.model), vendor: text(v.vendor), power_source: text(v.power_source, 32),
    supported: bool(v.supported), disabled: bool(v.disabled),
    interview_state: choice(v.interview_state, ['SUCCESSFUL', 'PENDING', 'IN_PROGRESS', 'FAILED']),
    endpoint_count: number(v.endpoint_count, 0, 32), has_state: bool(v.has_state),
    availability: availability(v.availability), ...projectTelemetry(v),
  });
}

const capabilities = (v) => {
  v = object(v);
  return { last_seen: v.last_seen === true, availability: v.availability === true, coordinator_check: false };
};

export function projectOutput(name, value) {
  const v = object(value);
  switch (name) {
    case 'z2m_connection_status':
      return clean({ configured: bool(v.configured), connected: bool(v.connected), broker_reachable: bool(v.broker_reachable),
        zigbee2mqtt_responding: bool(v.zigbee2mqtt_responding), broker_handshake: bool(v.broker_handshake),
        write_mode: 'off', tls: clean({ enabled: bool(object(v.tls).enabled), reject_unauthorized: bool(object(v.tls).reject_unauthorized) }),
        // No URL, base topic, client ID, free-form errors or diagnostic hints.
      });
    case 'z2m_get_device': return projectDevice(v);
    case 'z2m_list_devices': {
      const devices = array(v.devices, LIMITS.devices).map(projectDevice);
      return { total: number(v.total), returned: devices.length, capabilities: capabilities(v.capabilities), devices };
    }
    case 'z2m_list_groups': {
      const groups = projectGroups(v.groups);
      return { total: groups.length, groups };
    }
    case 'z2m_health_report': {
      // Detail strings are computed from intake-projected values by the pinned
      // upstream health report, never forwarded from MQTT log/event messages.
      const issues = {};
      for (const key of ['offline', 'stale', 'weak_link', 'low_battery', 'interview_incomplete', 'unsupported', 'disabled', 'update_available', 'rejoining', 'address_changing', 'silent']) {
        const refs = array(object(v.issues)[key], LIMITS.devices).map((item) => clean({ friendly_name: text(object(item).friendly_name), ieee_address: address(object(item).ieee_address) }));
        if (refs.length) issues[key] = refs;
      }
      const bridge = object(v.bridge), totals = object(v.totals);
      return { bridge: clean({ state: availability(bridge.state) ?? 'unknown', version: text(bridge.version, 64), permit_join: bool(bridge.permit_join), restart_required: bool(bridge.restart_required) }),
        totals: clean({ devices: number(totals.devices), routers: number(totals.routers), end_devices: number(totals.end_devices), issue_count: number(totals.issue_count) }),
        capabilities: capabilities(v.capabilities), issues };
    }
    default: throw new Error('Capability disabled by container policy');
  }
}

function validateArgs(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Buffer.byteLength(JSON.stringify(args)) > 4096) throw new Error('Invalid arguments');
  const allowed = {
    z2m_connection_status: [], z2m_get_device: ['device'], z2m_list_groups: [], z2m_get_logs: [],
    z2m_health_report: ['collect_seconds'],
    z2m_list_devices: ['search', 'type', 'availability', 'only_problems', 'has_update', 'sort_by', 'collect_seconds', 'limit'],
  }[name];
  if (!allowed || Object.keys(args).some((key) => !allowed.includes(key))) throw new Error('Unsupported arguments');
  for (const key of ['device', 'search']) if (args[key] !== undefined && (text(args[key]) === undefined || !args[key].trim())) throw new Error('Invalid identifier');
  if (name === 'z2m_get_device' && typeof args.device !== 'string') throw new Error('Device is required');
  for (const key of ['collect_seconds', 'limit']) if (args[key] !== undefined && (number(args[key], 1, key === 'limit' ? 1000 : 30) === undefined || !Number.isInteger(args[key]))) throw new Error('Invalid bound');
  for (const key of ['only_problems', 'has_update']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error('Invalid boolean');
  for (const [key, values] of Object.entries({ type: ['Router', 'EndDevice'], availability: ['online', 'offline', 'unknown'], sort_by: ['friendly_name', 'linkquality', 'battery', 'last_seen', 'model', 'vendor'] })) {
    if (args[key] !== undefined && !values.includes(args[key])) throw new Error('Invalid selector');
  }
}

export function hardenTools(tools) {
  return BASELINE.map((name) => {
    const tool = tools.find((tool) => tool.name === name);
    if (!tool) throw new Error('Reviewed baseline tool missing');
    const properties = { ...tool.inputSchema.properties };
    delete properties.include_raw;
    if (name === 'z2m_get_logs') for (const key of Object.keys(properties)) delete properties[key];
    if (properties.collect_seconds) properties.collect_seconds = { type: 'integer', minimum: 1, maximum: 30 };
    if (properties.limit) properties.limit = { type: 'integer', minimum: 1, maximum: 1000 };
    return { ...tool,
      description: name === 'z2m_get_logs' ? 'Return buffered log severity counts only. Log text, namespaces and events are disabled.'
        : `${name}: read-only, projected administrative metadata and health telemetry only. Raw state, definitions, options and free-form diagnostics are disabled.`,
      inputSchema: { ...tool.inputSchema, additionalProperties: false, properties },
      handler: async (args, ctx) => {
        try {
          validateArgs(name, args);
          if (name === 'z2m_get_logs') {
            await ctx.client.connect();
            const counts = { error: 0, warning: 0, info: 0 };
            for (const line of ctx.client.recentLogs().slice(-1000)) {
              const level = line.level === 'warn' ? 'warning' : line.level;
              if (Object.hasOwn(counts, level)) counts[level]++;
            }
            return { buffered_severity_counts: counts, log_text: 'disabled', events: 'disabled' };
          }
          return projectOutput(name, await tool.handler(args, ctx));
        } catch { throw new Error('Tool request failed or was refused by container policy'); }
      },
    };
  });
}
