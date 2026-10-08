# The managed MCP fixture executable alone, at the path the Runtime build
# stage leaves it, for runners that copy it out of that stage.
ARG RUNTIME_BUILD_IMAGE=antnest/antnest-runtime:managed-build
FROM ${RUNTIME_BUILD_IMAGE} AS fixture
FROM scratch
COPY --from=fixture /tmp/managed-mcp-fixture /tmp/managed-mcp-fixture
