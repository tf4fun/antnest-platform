# Test-only image; production Runtime never ships the fixture executable.
FROM antnest/antnest-runtime:managed-build AS fixture
FROM antnest/antnest-runtime:local
COPY --from=fixture /tmp/managed-mcp-fixture /usr/local/bin/managed-mcp-fixture
