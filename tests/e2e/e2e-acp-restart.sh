#!/bin/sh
set -eu
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || exit 1
[ "${ANTNEST_E2E_KEEP_STACK:-false}" = false ] || exit 1
case "${COMPOSE_PROJECT_NAME:-}" in antnest-stage3-e2e-[0-9]*) ;; *) exit 1 ;; esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$root/tests/support/service-hosts.sh"
evidence="$root/artifacts/verification/acp-restart/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
acp=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter label=com.docker.compose.service=agent-acp-service)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/antnest-restart.XXXXXX")
chmod 777 "$temporary"
client="${COMPOSE_PROJECT_NAME}-restart-client"
model="${COMPOSE_PROJECT_NAME}-restart-model"
umask 077
mkdir -p "$evidence"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+90000))')
  docker_cmd logs "$client" >"$evidence/client.log" 2>&1 || true
  docker_cmd cp "$client:/tmp/restart-traces" "$evidence/" >/dev/null 2>&1 || true
  docker_cmd cp "$client:/tmp/restart-business.json" "$evidence/" >/dev/null 2>&1 || true
  cp "$temporary"/*.json "$evidence/" 2>/dev/null || true
  docker_cmd rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  rm -rf "$temporary"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker_cmd inspect "$acp" >"$temporary/acp-initial.json"
node "$root/tests/e2e/acp-restart/ownership.mjs" owned "$temporary/acp-initial.json"
containers=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
docker_cmd inspect $containers >"$temporary/deployment.json"
node "$root/tests/e2e/stage3-base/deployment.mjs" "$temporary/deployment.json" "$COMPOSE_PROJECT_NAME"

image=${ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF:-antnest/antnest-runtime:local}
acp_image=$(docker_cmd inspect --format '{{.Image}}' "$acp")
docker_cmd image inspect "$image" >/dev/null
docker_cmd run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" --network "name=${COMPOSE_PROJECT_NAME}_acp-provider,alias=restart-model-peer" --network "name=${COMPOSE_PROJECT_NAME}_controller-provider,alias=restart-model-peer" -v "$root/tests:/app/tests:ro" "$acp_image" node /app/tests/e2e/acp-restart/model.mjs >/dev/null
# shellcheck disable=SC2086 # service_hosts is a list of options.
docker_cmd create --name "$client" $service_hosts --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" --network "${COMPOSE_PROJECT_NAME}_gateway-ingress" --network "${COMPOSE_PROJECT_NAME}_observability" --network "${COMPOSE_PROJECT_NAME}_acp-provider" --network "${COMPOSE_PROJECT_NAME}_controller-runtime" --network "${COMPOSE_PROJECT_NAME}_identity-clients" --network "${COMPOSE_PROJECT_NAME}_edge" \
  --user "$ANTNEST_SERVICE_AUTH_UID:$ANTNEST_SERVICE_AUTH_GID" -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/agent-controller/tokens/runtime-controller:/run/auth/controller-runtime:ro" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/edge-gateway/tokens/identity-service:/run/auth/gateway-identity:ro" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/agent-ui/tokens/agent-acp-service:/run/auth/agent-ui-acp:ro" \
  -v "$root/contracts/identity/identity-contract.json:/app/contracts/identity/identity-contract.json:ro" \
  -v "$root/contracts/agent-controller/control-contract.json:/app/contracts/agent-controller/control-contract.json:ro" \
  -v "$root/services/runtime-controller/api/control-contract.json:/app/services/runtime-controller/api/control-contract.json:ro" \
  -v "$root/contracts/agent-acp/agent-execution-state.schema.json:/app/contracts/agent-acp/agent-execution-state.schema.json:ro" \
  -e "TEST_RUNTIME_IMAGE=$image" -v "$root/tests:/app/tests:ro" -v "$temporary:/checkpoints" "$acp_image" node /app/tests/e2e/acp-restart/client.mjs >/dev/null
docker_cmd start "$client" >/dev/null
for step in 1 2 3 4 5 6 7 8; do
  attempt=0
  until [ -f "$temporary/request-$step" ]; do
    [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ] || { docker_cmd logs "$client"; exit 1; }
    attempt=$((attempt+1)); [ "$attempt" -le 180 ] || exit 1
    sleep 1
  done
  docker_cmd inspect "$acp" >"$temporary/before-$step.json"
  node "$root/tests/e2e/acp-restart/ownership.mjs" owned "$temporary/before-$step.json"
  node "$root/tests/e2e/acp-closeout/inflight-barrier.mjs" "$temporary/request-$step" >"$temporary/proof-$step"
  chmod 644 "$temporary/proof-$step"
  docker_cmd kill --signal KILL "$acp" >/dev/null
  attempt=0
  while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$acp")" = true ]; do
    attempt=$((attempt+1)); [ "$attempt" -le 60 ] || { echo 'ACP SIGKILL did not settle' >&2; exit 1; }
    sleep 1
  done
  docker_cmd inspect "$acp" >"$temporary/stopped-$step.json"
  node "$root/tests/e2e/acp-restart/process.mjs" "$temporary/before-$step.json" "$temporary/stopped-$step.json"
  docker_cmd start "$acp" >/dev/null
  attempt=0
  until [ "$(docker_cmd inspect --format '{{.State.Health.Status}}' "$acp")" = healthy ]; do
    attempt=$((attempt+1)); [ "$attempt" -le 60 ] || exit 1
    sleep 1
  done
  docker_cmd inspect "$acp" >"$temporary/after-$step.json"
  node "$root/tests/e2e/acp-restart/ownership.mjs" restarted "$temporary/before-$step.json" "$temporary/after-$step.json"
  touch "$temporary/done-$step"
  echo "ACP interruption $step/8: SIGKILL 137, same container restarted healthy" >&2
  case "$step" in
    4|8)
      attempt=0
      until [ -f "$temporary/retire-request-$step" ]; do
        [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ] || { docker_cmd logs "$client"; exit 1; }
        attempt=$((attempt+1)); [ "$attempt" -le 150 ] || exit 1
        sleep 1
      done
      node "$root/tests/e2e/acp-closeout/inflight-barrier.mjs" "$temporary/proof-$step" retired
      touch "$temporary/retired-$step"
      ;;
  esac
done
while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ]; do sleep 1; done
status=$(docker_cmd inspect --format '{{.State.ExitCode}}' "$client")
docker_cmd logs "$client"
if docker_cmd cp "$client:/tmp/restart-business.json" "$temporary/business.json" >/dev/null 2>&1; then
  node -e 'const a=require("node:assert/strict"),b=require(process.argv[1]);a.equal(b.status,"business_passed");a.equal(b.deleted,true);' "$temporary/business.json"
  node "$root/tests/e2e/acp-restart/deletion-resources-cli.mjs" "$COMPOSE_PROJECT_NAME" "$evidence"
else
  [ "$status" != 0 ] || status=1
fi
exit "$status"
