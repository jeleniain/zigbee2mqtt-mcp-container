#!/bin/sh
set -eu
# The gateway bearer credential is not an MQTT child credential.
unset SUPERGATEWAY_API_KEY
: "${Z2M_CONTAINER_CLIENT_PREFIX:?Container entrypoint must set a client prefix}"
export Z2M_MQTT_CLIENT_ID="${Z2M_CONTAINER_CLIENT_PREFIX}-$$"
exec /usr/local/bin/node /opt/zigbee2mqtt-mcp/dist/index.js
