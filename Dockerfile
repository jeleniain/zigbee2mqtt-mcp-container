FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build

# Archive hashes verified against these exact upstream commits, not release tags.
ADD --checksum=sha256:3fd36c5e167e530c242036ba789d72a367b62d498ba189c29e2b884c94c02b62 https://codeload.github.com/alexpfau/zigbee2mqtt-mcp/tar.gz/508a9215f78672f43bd64571d38c3ae2342ea040 /tmp/zigbee2mqtt-mcp.tar.gz
ADD --checksum=sha256:08d57d026ebeff81ceb58f665c0fe8b729e6d702e2dfe2c904c3b1df91524840 https://codeload.github.com/supercorp-ai/supergateway/tar.gz/8079a99bd8db85700f415b6336b44b81c0ab5483 /tmp/supergateway.tar.gz
COPY licenses/ /licenses/
RUN mkdir -p /build/zigbee2mqtt-mcp /build/supergateway \
    && tar -xzf /tmp/zigbee2mqtt-mcp.tar.gz --strip-components=1 -C /build/zigbee2mqtt-mcp \
    && tar -xzf /tmp/supergateway.tar.gz --strip-components=1 -C /build/supergateway \
    && cmp /build/zigbee2mqtt-mcp/LICENSE /licenses/zigbee2mqtt-mcp.LICENSE \
    && cmp /build/supergateway/LICENSE /licenses/supergateway.LICENSE

WORKDIR /build/zigbee2mqtt-mcp
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund
WORKDIR /build/supergateway
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
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
COPY entrypoint.mjs child.sh ./
USER node
EXPOSE 8000
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "/opt/container/entrypoint.mjs"]
CMD []
