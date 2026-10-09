ARG EGRESS_TEST_BUILD_IMAGE
FROM ${EGRESS_TEST_BUILD_IMAGE} AS build
FROM node:24.21.0-bookworm-slim
COPY --from=build /tmp/wire-probe /usr/local/bin/wire-probe
