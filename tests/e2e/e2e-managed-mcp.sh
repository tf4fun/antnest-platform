#!/bin/sh
set -eu
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Use make e2e-managed-mcp-v1' >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$root/tests/support/service-hosts.sh"
evidence="$root/artifacts/verification/managed-mcp/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
model="${COMPOSE_PROJECT_NAME}-managed-model"
client="${COMPOSE_PROJECT_NAME}-managed-client"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/antnest-managed-mcp.XXXXXX")
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+60000))')
  docker_cmd rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  rm -rf "$temporary"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
containers=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
# IDs originate from Docker and contain no shell metacharacters.
docker_cmd inspect $containers >"$temporary/deployment.json"
node "$root/tests/e2e/stage3-base/deployment.mjs" "$temporary/deployment.json" "$COMPOSE_PROJECT_NAME"
image=antnest/antnest-runtime:managed-integration
docker_cmd image inspect "$image" >/dev/null
docker_cmd run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "name=${COMPOSE_PROJECT_NAME}_acp-provider,alias=managed-model" \
  --network "name=${COMPOSE_PROJECT_NAME}_controller-provider,alias=managed-model" \
  -v "$root/tests:/app/tests:ro" \
  antnest/agent-acp-service:local node /app/tests/e2e/managed-mcp/model.mjs >/dev/null
# shellcheck disable=SC2086 # service_hosts is a list of options.
docker_cmd create --name "$client" $service_hosts --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_gateway-ingress" --network "${COMPOSE_PROJECT_NAME}_observability" \
  --network "${COMPOSE_PROJECT_NAME}_acp-provider" --network "${COMPOSE_PROJECT_NAME}_controller-runtime" \
  --user "$ANTNEST_SERVICE_AUTH_UID:$ANTNEST_SERVICE_AUTH_GID" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/agent-controller/tokens/runtime-controller:/run/auth/controller-runtime:ro" \
  -e TEST_RC_TOKEN_FILE=/run/auth/controller-runtime \
  -e "TEST_RUNTIME_IMAGE=$image" -e "TEST_ACP_VERSION=${ANTNEST_E2E_MANAGED_MCP_VERSION:-1}" \
  -v "$root/tests:/app/tests:ro" \
  antnest/agent-acp-service:local node /app/tests/e2e/managed-mcp/client.mjs >/dev/null
docker_cmd start "$client" >/dev/null
while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ]; do sleep 1; done
status=$(docker_cmd inspect --format '{{.State.ExitCode}}' "$client")
docker_cmd logs "$client"
umask 077
mkdir -p "$evidence"
docker_cmd cp "$client:/tmp/managed-traces" "$evidence/" >/dev/null 2>&1 || true
if docker_cmd cp "$client:/tmp/managed-business.json" "$temporary/business.json" >/dev/null 2>&1; then
  node -e 'const assert=require("node:assert/strict"); const b=require(process.argv[1]); assert.equal(b.status,"business_passed"); assert.equal(b.deleted,true);' "$temporary/business.json"
  [ -z "$(docker_cmd ps -aq --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME")" ] || { echo 'Deleted Agent retained a Runtime container' >&2; exit 1; }
  [ -z "$(docker_cmd volume ls -q --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME")" ] || { echo 'Deleted Agent retained a Runtime volume' >&2; exit 1; }
  echo '{"status":"deletion_resources_passed","runtime_containers":0,"runtime_volumes":0}'
else
  [ "$status" != 0 ] || status=1
fi
exit "$status"
