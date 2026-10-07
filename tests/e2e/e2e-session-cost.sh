#!/bin/sh
set -eu

[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo "Use make e2e-session-cost" >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$root/tests/support/service-hosts.sh"
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
. "$root/tests/e2e/acp-closeout/container-state.sh"
model="${COMPOSE_PROJECT_NAME}-cost-model"
client="${COMPOSE_PROJECT_NAME}-cost-client"
acp="${COMPOSE_PROJECT_NAME}-agent-acp-service-1"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+60000))')
  docker_cmd rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
image=antnest/antnest-runtime:local
docker_cmd image inspect "$image" >/dev/null
docker_cmd run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "name=${COMPOSE_PROJECT_NAME}_acp-provider,alias=acp-closeout-model" \
  --network "name=${COMPOSE_PROJECT_NAME}_controller-provider,alias=acp-closeout-model" \
  -v "$root/tests:/app/tests:ro" \
  antnest/agent-acp-service:local node /app/tests/e2e/acp-cost/model.mjs >/dev/null
# shellcheck disable=SC2086 # service_hosts is a list of options.
docker_cmd create --name "$client" $service_hosts --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_gateway-ingress" --network "${COMPOSE_PROJECT_NAME}_observability" \
  --network "${COMPOSE_PROJECT_NAME}_acp-provider" -e "TEST_RUNTIME_IMAGE=$image" \
  -v "$root/tests:/app/tests:ro" \
  antnest/agent-acp-service:local node /app/tests/e2e/acp-cost/client.mjs >/dev/null
docker_cmd start "$client" >/dev/null
restarted=false
while :; do
  state=$(client_state "$client")
  if [ "$state" != running ]; then
    status=${state#exited:}
    break
  fi
  if [ "$restarted" = false ]; then
    checkpoint=$(docker_cmd exec "$model" node --input-type=module -e \
      'const r=await fetch("http://127.0.0.1:8080/status",{signal:AbortSignal.timeout(5000)}); console.log((await r.json()).checkpoint)')
    if [ "$checkpoint" = restart ]; then
      docker_cmd --lifecycle restart --time 10 "$acp" >/dev/null
      wait_for_health "$acp"
      docker_cmd exec "$model" node --input-type=module -e \
        'const r=await fetch("http://127.0.0.1:8080/restarted",{method:"POST",signal:AbortSignal.timeout(5000)}); if(!r.ok)process.exit(1)'
      restarted=true
    fi
  fi
  sleep 1
done
docker_cmd logs "$client"
[ "$status" -ne 0 ] || [ "$restarted" = true ] || status=1
exit "$status"
