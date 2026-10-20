#!/bin/sh
set -eu
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Use make e2e-managed-mcp-v1' >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$root/tests/support/service-hosts.sh"
evidence="$root/artifacts/verification/managed-mcp/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
umask 077
mkdir -p "$evidence"
client_created=false
model_created=false
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
model="${COMPOSE_PROJECT_NAME}-managed-model"
client="${COMPOSE_PROJECT_NAME}-managed-client"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/antnest-managed-mcp.XXXXXX")
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+60000))')
  if [ "$client_created" = true ]; then
    docker_cmd logs "$client" >"$evidence/client.log" 2>&1 || status=1
  fi
  if [ "$model_created" = true ]; then
    docker_cmd logs "$model" >"$evidence/model.log" 2>&1 || status=1
  fi
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
# Pin both fixture clients to the actual deployed service image.
set -- $(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter 'label=com.docker.compose.service=agent-acp-service')
[ "$#" = 1 ] || { echo 'Exactly one deployed ACP container required' >&2; exit 1; }
acp_image=$(docker_cmd inspect --format '{{.Image}}' "$1")
case "$acp_image" in sha256:*) ;; *) echo 'Deployed ACP image identity missing' >&2; exit 1 ;; esac
printf '%s\n' "$acp_image" >"$evidence/acp-image.txt"
image=antnest/antnest-runtime:managed-integration
docker_cmd image inspect "$image" >/dev/null
docker_cmd run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "name=${COMPOSE_PROJECT_NAME}_acp-provider,alias=managed-model" \
  --network "name=${COMPOSE_PROJECT_NAME}_controller-provider,alias=managed-model" \
  -v "$root/tests:/app/tests:ro" \
  "$acp_image" node /app/tests/e2e/managed-mcp/model.mjs >/dev/null
model_created=true
# shellcheck disable=SC2086 # service_hosts is a list of options.
docker_cmd create --name "$client" $service_hosts --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_gateway-ingress" --network "${COMPOSE_PROJECT_NAME}_observability" \
  --network "${COMPOSE_PROJECT_NAME}_acp-provider" --network "${COMPOSE_PROJECT_NAME}_controller-runtime" \
  --network "${COMPOSE_PROJECT_NAME}_edge" --network "${COMPOSE_PROJECT_NAME}_identity-clients" \
  --user "$ANTNEST_SERVICE_AUTH_UID:$ANTNEST_SERVICE_AUTH_GID" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/agent-controller/tokens/runtime-controller:/run/auth/controller-runtime:ro" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/edge-gateway/tokens/identity-service:/run/auth/gateway-identity:ro" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/agent-ui/tokens/agent-acp-service:/run/auth/agent-ui-acp:ro" \
  -e TEST_RC_TOKEN_FILE=/run/auth/controller-runtime \
  -e "TEST_RUNTIME_IMAGE=$image" -e "TEST_ACP_VERSION=${ANTNEST_E2E_MANAGED_MCP_VERSION:-1}" \
  -e TEST_EVIDENCE_DIRECTORY=/evidence -e "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME" \
  -v "$evidence:/evidence" \
  -v "$root/tests:/app/tests:ro" \
  -v "$root/contracts/agent-acp/agent-execution-state.schema.json:/app/contracts/agent-acp/agent-execution-state.schema.json:ro" \
  -v "$root/contracts/agent-ui/workspace-api.schema.json:/app/contracts/agent-ui/workspace-api.schema.json:ro" \
  -v "$root/services/agent-ui/web/src/lib:/app/services/agent-ui/web/src/lib:ro" \
  -v "$root/services/agent-ui/web/server/src/protocol:/app/services/agent-ui/web/server/src/protocol:ro" \
  "$acp_image" node /app/tests/e2e/managed-mcp/client.mjs >/dev/null
client_created=true
docker_cmd start "$client" >/dev/null
while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ]; do sleep 1; done
status=$(docker_cmd inspect --format '{{.State.ExitCode}}' "$client")
if [ "$status" = 0 ] || [ "$status" = 2 ]; then
  node --input-type=module -e 'import {readFileSync} from "node:fs"; const {assertManagedDelivery}=await import(process.argv[1]); assertManagedDelivery({complete:true,exit_code:Number(process.argv[3])},JSON.parse(readFileSync(process.argv[2],"utf8")),{version:Number(process.argv[4]),project:process.argv[5]});' \
    "$root/tests/e2e/managed-mcp/delivery.mjs" "$evidence/managed-complete.json" "$status" "${ANTNEST_E2E_MANAGED_MCP_VERSION:-1}" "$COMPOSE_PROJECT_NAME"
  [ -z "$(docker_cmd ps -aq --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME")" ] || { echo 'Deleted Agent retained a Runtime container' >&2; exit 1; }
  [ -z "$(docker_cmd volume ls -q --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME")" ] || { echo 'Deleted Agent retained a Runtime volume' >&2; exit 1; }
  echo '{"status":"deletion_resources_passed","runtime_containers":0,"runtime_volumes":0}'
fi
exit "$status"
