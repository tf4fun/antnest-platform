# Test-only image; production Runtime never ships the fixture executable.
ARG RUNTIME_BUILD_IMAGE=antnest/antnest-runtime:managed-build
ARG RUNTIME_IMAGE=antnest/antnest-runtime:local
FROM ${RUNTIME_BUILD_IMAGE} AS fixture
FROM ${RUNTIME_IMAGE}
COPY --from=fixture /tmp/managed-mcp-fixture /usr/local/bin/managed-mcp-fixture
