#!/bin/sh
set -eu

# Invoked by e2e-stage3a after its ordinary user has logged in. The parent trap
# owns all cleanup, including containers started here, on success and failure.
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=${ANTNEST_E2E_MANAGED_MCP_VERSION:-1}
case "$version" in
  1|2) ;;
  *) echo 'ANTNEST_E2E_MANAGED_MCP_VERSION must be 1 or 2' >&2; exit 1 ;;
esac
ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now() + 900000))')
export ANTNEST_E2E_DEADLINE_MS
docker() { node "$root/scripts/acp-closeout/docker.mjs" "$@"; }
image=$(docker image inspect --format '{{.Id}}' antnest/antnest-runtime:managed-integration)
model="${COMPOSE_PROJECT_NAME}-managed-model"
diagnostics() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then docker logs --tail=40 "$model" >&2 || true; fi
  exit "$status"
}
trap diagnostics EXIT
docker run -d --rm --name "$model" \
  --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --label "io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" --network-alias managed-model \
  -v "$root/scripts:/app/scripts:ro" \
  antnest/agent-acp-service:local node /app/scripts/managed-mcp/model.mjs >/dev/null
docker --lifecycle run --rm \
  --label "io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" \
  -e TEST_ORGANIZATION_ID -e TEST_OWNER_ID -e TEST_USER_COOKIE \
  -e "TEST_RUNTIME_IMAGE=$image" \
  -e "TEST_ACP_VERSION=$version" \
  -v "$root/scripts:/app/scripts:ro" \
  antnest/agent-acp-service:local node /app/scripts/managed-mcp/client.mjs
docker rm -f "$model" >/dev/null
