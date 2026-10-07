#!/bin/sh
set -eu
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Use make e2e-rpc-response-loss' >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
evidence="$root/artifacts/verification/rpc-response-loss/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
model="${COMPOSE_PROJECT_NAME}-rpc-model"
client="${COMPOSE_PROJECT_NAME}-rpc-client"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/antnest-rpc-loss.XXXXXX")
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
docker_cmd inspect $containers >"$temporary/before.json"
node "$root/tests/e2e/rpc-response-loss/deployment.mjs" "$temporary/before.json" "$COMPOSE_PROJECT_NAME"
image=$(docker_cmd image inspect --format '{{.Id}}' antnest/antnest-runtime:local)
docker_cmd run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "name=${COMPOSE_PROJECT_NAME}_acp-provider,alias=rpc-model-peer" --network "name=${COMPOSE_PROJECT_NAME}_controller-provider,alias=rpc-model-peer" \
  -v "$root/tests:/app/tests:ro" \
  antnest/agent-acp-service:local node /app/tests/e2e/rpc-response-loss/model.mjs >/dev/null
docker_cmd create --name "$client" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_gateway-ingress" --network "${COMPOSE_PROJECT_NAME}_observability" --network "${COMPOSE_PROJECT_NAME}_acp-provider" --network "${COMPOSE_PROJECT_NAME}_controller-runtime" --network "${COMPOSE_PROJECT_NAME}_controller-acp" \
  --user "$ANTNEST_SERVICE_AUTH_UID:$ANTNEST_SERVICE_AUTH_GID" -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/agent-controller/tokens/runtime-controller:/run/auth/controller-runtime:ro" \
  -e "TEST_RUNTIME_IMAGE=$image" \
  -v "$root/tests:/app/tests:ro" \
  antnest/agent-acp-service:local node /app/tests/e2e/rpc-response-loss/client.mjs >/dev/null
docker_cmd start "$client" >/dev/null
while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ]; do sleep 1; done
status=$(docker_cmd inspect --format '{{.State.ExitCode}}' "$client")
docker_cmd logs "$client"
docker_cmd inspect $containers >"$temporary/after.json"
node "$root/tests/e2e/rpc-response-loss/deployment.mjs" "$temporary/before.json" "$COMPOSE_PROJECT_NAME" "$temporary/after.json"
umask 077
mkdir -p "$evidence"
docker_cmd cp "$client:/tmp/rpc-traces" "$evidence/" >/dev/null 2>&1 || true
if docker_cmd cp "$client:/tmp/rpc-business.json" "$temporary/business.json" >/dev/null 2>&1; then
  node -e 'const assert=require("node:assert/strict"); const b=require(process.argv[1]); assert.equal(b.status,"business_passed"); assert.equal(b.deleted,true);' "$temporary/business.json"
  [ -z "$(docker_cmd ps -aq --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME")" ] || { echo 'Deleted Agent retained a Runtime container' >&2; exit 1; }
  [ -z "$(docker_cmd volume ls -q --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME")" ] || { echo 'Deleted Agent retained a Runtime volume' >&2; exit 1; }
  echo '{"status":"deletion_resources_passed","runtime_containers":0,"runtime_volumes":0}'
else
  [ "$status" != 0 ] || status=1
fi
exit "$status"
