#!/bin/sh
set -eu
umask 077
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Use make e2e-rpc-response-loss' >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$root/tests/support/service-hosts.sh"
evidence="$root/artifacts/verification/rpc-response-loss/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
model="${COMPOSE_PROJECT_NAME}-rpc-model"
client="${COMPOSE_PROJECT_NAME}-rpc-client"
mkdir -p "$evidence"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+120000))')
  if mkdir -p "$evidence"; then
    docker_cmd cp "$client:/tmp/rpc-traces" "$evidence/" >/dev/null 2>&1 || status=1
    docker_cmd cp "$client:/tmp/rpc-business.json" "$evidence/business.json" >/dev/null 2>&1 || status=1
    docker_cmd logs --timestamps "$client" >"$evidence/client.log" 2>&1 || status=1
    docker_cmd logs --timestamps "${COMPOSE_PROJECT_NAME}-admin-console-1" >"$evidence/admin-console.log" 2>&1 || status=1
    chmod -R u+rwX,go-rwx "$evidence" || status=1
  else
    status=1
  fi
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+60000))')
  docker_cmd rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
containers=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
docker_cmd inspect $containers >"$evidence/before.json"
node "$root/tests/e2e/rpc-response-loss/deployment.mjs" "$evidence/before.json" "$COMPOSE_PROJECT_NAME"
image=${ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF:-antnest/antnest-runtime:local}
acp=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter label=com.docker.compose.service=agent-acp-service)
acp_image=$(docker_cmd inspect --format '{{.Image}}' "$acp")
docker_cmd image inspect "$image" >/dev/null
docker_cmd run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "name=${COMPOSE_PROJECT_NAME}_acp-provider,alias=rpc-model-peer" --network "name=${COMPOSE_PROJECT_NAME}_controller-provider,alias=rpc-model-peer" \
  -v "$root/tests:/app/tests:ro" \
  "$acp_image" node /app/tests/e2e/rpc-response-loss/model.mjs >/dev/null
# shellcheck disable=SC2086 # service_hosts is a list of options.
docker_cmd create --name "$client" $service_hosts --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_gateway-ingress" --network "${COMPOSE_PROJECT_NAME}_observability" --network "${COMPOSE_PROJECT_NAME}_acp-provider" --network "${COMPOSE_PROJECT_NAME}_controller-runtime" --network "${COMPOSE_PROJECT_NAME}_controller-acp" --network "${COMPOSE_PROJECT_NAME}_identity-clients" --network "${COMPOSE_PROJECT_NAME}_edge" \
  --user "$ANTNEST_SERVICE_AUTH_UID:$ANTNEST_SERVICE_AUTH_GID" -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/agent-controller/tokens/runtime-controller:/run/auth/controller-runtime:ro" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/edge-gateway/tokens/identity-service:/run/auth/gateway-identity:ro" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/agent-ui/tokens/agent-acp-service:/run/auth/agent-ui-acp:ro" \
  -v "$root/contracts/identity/identity-contract.json:/app/contracts/identity/identity-contract.json:ro" \
  -v "$root/contracts/agent-controller/control-contract.json:/app/contracts/agent-controller/control-contract.json:ro" \
  -v "$root/services/runtime-controller/api/control-contract.json:/app/services/runtime-controller/api/control-contract.json:ro" \
  -v "$root/contracts/agent-acp/agent-execution-state.schema.json:/app/contracts/agent-acp/agent-execution-state.schema.json:ro" \
  -e "TEST_RUNTIME_IMAGE=$image" \
  -v "$root/tests:/app/tests:ro" \
  "$acp_image" node /app/tests/e2e/rpc-response-loss/client.mjs >/dev/null
docker_cmd start "$client" >/dev/null
while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ]; do sleep 1; done
status=$(docker_cmd inspect --format '{{.State.ExitCode}}' "$client")
docker_cmd logs "$client"
docker_cmd inspect $containers >"$evidence/after.json"
node "$root/tests/e2e/rpc-response-loss/deployment.mjs" "$evidence/before.json" "$COMPOSE_PROJECT_NAME" "$evidence/after.json"
if docker_cmd cp "$client:/tmp/rpc-business.json" "$evidence/business.json" >/dev/null 2>&1; then
  node -e 'const assert=require("node:assert/strict"); const b=require(process.argv[1]); assert.equal(b.status,"business_passed"); assert.equal(b.deleted,true);' "$evidence/business.json"
  [ -z "$(docker_cmd ps -aq --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME")" ] || { echo 'Deleted Agent retained a Runtime container' >&2; exit 1; }
  [ -z "$(docker_cmd volume ls -q --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME")" ] || { echo 'Deleted Agent retained a Runtime volume' >&2; exit 1; }
  echo '{"status":"deletion_resources_passed","runtime_containers":0,"runtime_volumes":0}'
else
  [ "$status" != 0 ] || status=1
fi
exit "$status"
