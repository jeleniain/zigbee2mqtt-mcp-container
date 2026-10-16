FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build

# Archive hashes verified against these exact upstream commits, not release tags.
ADD --checksum=sha256:3fd36c5e167e530c242036ba789d72a367b62d498ba189c29e2b884c94c02b62 https://codeload.github.com/alexpfau/zigbee2mqtt-mcp/tar.gz/508a9215f78672f43bd64571d38c3ae2342ea040 /tmp/zigbee2mqtt-mcp.tar.gz
ADD --checksum=sha256:08d57d026ebeff81ceb58f665c0fe8b729e6d702e2dfe2c904c3b1df91524840 https://codeload.github.com/supercorp-ai/supergateway/tar.gz/8079a99bd8db85700f415b6336b44b81c0ab5483 /tmp/supergateway.tar.gz
COPY licenses/ /licenses/
COPY dependencies/ /dependency-overlay/
COPY scripts/install-gateway-policy.mjs /build/install-gateway-policy.mjs
COPY scripts/patch-upstream-security.mjs scripts/security-boundary.mjs /build/security/
RUN mkdir -p /build/zigbee2mqtt-mcp /build/supergateway \
    && tar -xzf /tmp/zigbee2mqtt-mcp.tar.gz --strip-components=1 -C /build/zigbee2mqtt-mcp \
    && tar -xzf /tmp/supergateway.tar.gz --strip-components=1 -C /build/supergateway \
    && cmp /build/zigbee2mqtt-mcp/LICENSE /licenses/zigbee2mqtt-mcp.LICENSE \
    && cmp /build/supergateway/LICENSE /licenses/supergateway.LICENSE \
    && node /dependency-overlay/overlay.mjs zigbee2mqtt-mcp /build/zigbee2mqtt-mcp \
    && node /dependency-overlay/overlay.mjs supergateway /build/supergateway \
    && node /build/security/patch-upstream-security.mjs /build/zigbee2mqtt-mcp

WORKDIR /build/zigbee2mqtt-mcp
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund
WORKDIR /build/supergateway
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm run build \
    && node /build/install-gateway-policy.mjs /build/supergateway \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund
RUN node /dependency-overlay/trim-runtime.mjs /build/zigbee2mqtt-mcp/node_modules /build/supergateway/node_modules

# Clean runtime lineage: do not inherit npm, Corepack, or build-image layers.
# Distroless cc keeps glibc, libstdc++ and dpkg metadata for scanning, but no
# shell, package manager, util-linux, ncurses or perl.
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS runtime
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /usr/local/LICENSE /usr/share/licenses/node/LICENSE
LABEL org.opencontainers.image.title="zigbee2mqtt-mcp-container" \
    io.zigbee2mqtt-mcp.revision="508a9215f78672f43bd64571d38c3ae2342ea040" \
    io.supergateway.revision="8079a99bd8db85700f415b6336b44b81c0ab5483"
ENV NODE_ENV=production
WORKDIR /opt/container
COPY --from=build /build/zigbee2mqtt-mcp/dist/ /opt/zigbee2mqtt-mcp/dist/
COPY --from=build /build/zigbee2mqtt-mcp/node_modules/ /opt/zigbee2mqtt-mcp/node_modules/
COPY --from=build /build/zigbee2mqtt-mcp/package.json /opt/zigbee2mqtt-mcp/package.json
COPY --from=build /build/supergateway/dist/ /opt/supergateway/dist/
COPY --from=build /build/supergateway/node_modules/ /opt/supergateway/node_modules/
COPY --from=build /build/supergateway/package.json /opt/supergateway/package.json
# Dependency notices remain in each unmodified production node_modules tree.
COPY licenses/ /usr/share/licenses/zigbee2mqtt-mcp-container/
COPY entrypoint.mjs http-policy.mjs child-policy.mjs ./
USER 65532:65532
EXPOSE 8000
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/node", "/opt/container/entrypoint.mjs"]
CMD []
