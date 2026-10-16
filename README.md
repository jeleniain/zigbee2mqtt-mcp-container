# zigbee2mqtt-mcp-container

A hardened container that serves [alexpfau/zigbee2mqtt-mcp](https://github.com/alexpfau/zigbee2mqtt-mcp) over authenticated Streamable HTTP through [supercorp-ai/supergateway](https://github.com/supercorp-ai/supergateway). It is meant to run as a persistent Docker container (for example on Unraid), so MCP clients can connect to it remotely instead of launching the server on their own machine.

The container is **read-only**: it never publishes to MQTT, and exposes six passive tools that return a limited, projected view of your Zigbee network.

```
ghcr.io/jeleniain/zigbee2mqtt-mcp-container:latest
```

Each release is also tagged `sha-<commit>`. Pin by digest for a fixed build.

## Run

```bash
docker run -d --name zigbee2mqtt-mcp \
  --init --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 8000:8000 \
  -e SUPERGATEWAY_API_KEY='<long random key>' \
  -e Z2M_MQTT_URL='mqtts://broker.example:8883' \
  -e Z2M_MQTT_USERNAME='<read-only MQTT user>' \
  -e Z2M_MQTT_PASSWORD='<password>' \
  -e Z2M_HTTP_ALLOWED_HOSTS='mcp.example:8000' \
  ghcr.io/jeleniain/zigbee2mqtt-mcp-container:latest
```

On Unraid, add a container with that repository, put the flags in **Extra Parameters**, and add each variable. Keep the API key and MQTT password in Unraid, never in this repository or an image.

MCP clients connect to `http://<host>:8000/mcp` with the header `Authorization: Bearer <SUPERGATEWAY_API_KEY>`.

## Settings

| Variable | Required | Notes |
|---|---|---|
| `SUPERGATEWAY_API_KEY` | yes | Printable ASCII, no spaces. Not passed to the MCP server process. |
| `Z2M_MQTT_URL` | yes | `mqtts://` or `wss://` only. No credentials in the URL. |
| `Z2M_MQTT_USERNAME`, `Z2M_MQTT_PASSWORD` | usually | Use a broker user that can only read Zigbee2MQTT topics. |
| `Z2M_HTTP_ALLOWED_HOSTS` | yes | Comma-separated `host:port` values exactly as clients send them in the `Host` header. Other hosts get 403. |
| `Z2M_MQTT_CA` | if needed | Path to the broker's CA certificate, for a private CA. Mount it read-only, e.g. `-v /mnt/user/appdata/z2m-mcp/ca.pem:/run/z2m/ca.pem:ro` and `Z2M_MQTT_CA=/run/z2m/ca.pem`. |
| `Z2M_BASE_TOPIC` | no | Default `zigbee2mqtt`. |

Forced by the container regardless of settings: write mode off, TLS certificate verification on, application logging silent. `Z2M_MQTT_CLIENT_ID` and `SUPERGATEWAY_API_KEY_FILE` are refused; each session gets a unique client ID.

If startup fails, the container log has one line naming the setting to fix. Values are never printed.

## Tools

| Tool | Returns |
|---|---|
| `z2m_connection_status` | Connection and TLS flags; no URL, topic, or client ID |
| `z2m_list_devices` | Device names, IEEE addresses, model, vendor, availability, link quality, battery, last seen, update status |
| `z2m_get_device` | The same fields for one device |
| `z2m_health_report` | Offline, stale, weak-link, low-battery and similar issues, by device |
| `z2m_list_groups` | Group IDs, names and member addresses |
| `z2m_get_logs` | Counts of buffered log lines by severity only |

Excluded: all write tools, `z2m_bridge_info`, `z2m_network_map`, `z2m_coordinator_check`. Raw device state, exposes, options, endpoint bindings, scenes, log text and bridge events are not returned. Incoming MQTT messages are reduced to these fields when received, so the raw data is not cached either.

## Security notes

- **Put HTTPS in front of it.** The listener is plain HTTP. The API key is authentication, not encryption. Use a reverse proxy or tunnel with TLS, and do not expose port 8000 directly.
- **Restrict the broker user.** The container refuses to publish, but the broker's ACL is the real boundary: allow read on the Zigbee2MQTT topics and nothing else.
- **Non-browser clients only.** Requests carrying an `Origin` header are rejected.
- **Limits.** At most 4 concurrent MCP sessions; idle sessions close after 30 minutes. Add Docker memory, CPU and PID limits as you see fit.
- **Device names and group names are returned as-is.** Do not put secrets in them.
- Passing scans is not proof of safety. Remaining findings are in each CI run's security reports.

## How the image is built

- Both upstream projects are downloaded at pinned commits with verified checksums (`508a921` and `8079a99`), then built from reviewed lockfiles that only update dependency versions with fixes ([dependencies/](dependencies/)).
- [scripts/patch-upstream-security.mjs](scripts/patch-upstream-security.mjs) checks the exact upstream source, then adds the output and intake limits from [scripts/security-boundary.mjs](scripts/security-boundary.mjs) and disables publishing. If upstream changes, the build fails instead of patching blindly.
- [scripts/install-gateway-policy.mjs](scripts/install-gateway-policy.mjs) adds the Host/Origin check ([http-policy.mjs](http-policy.mjs)) and the session limit and direct launcher ([child-policy.mjs](child-policy.mjs)) to the gateway.
- The runtime is `gcr.io/distroless/cc-debian12:nonroot` with only the Node binary added: no shell, package manager, npm or Corepack. It runs as UID 65532.

## CI and releases

[.github/workflows/build.yml](.github/workflows/build.yml) runs manually. It runs the tests (including leak tests against the real patched upstream), scans Git history, source and every image layer for secrets, builds the image and smoke-tests it offline, and blocks on fixable HIGH/CRITICAL vulnerabilities. Reports and a CycloneDX SBOM are kept as artifacts.

With `publish` ticked, the `ghcr-release` environment requires a reviewer's approval. The publish job then pushes the exact archive that was tested and scanned, without rebuilding, and checks that the registry's config digest matches it. `stable` also moves `latest`.

Local tests: `node --test`. Set `Z2M_SECURITY_FIXTURE` to a patched, built upstream checkout to also run the real-handler leak test.

## Licenses

Both upstream projects are MIT-licensed; their notices are kept in [licenses/](licenses/) and in the image: Copyright (c) 2026 Alex Pfau and Copyright (c) 2024 Supercorp. Dependency notices remain in each package in the image.
