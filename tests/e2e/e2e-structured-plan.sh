#!/bin/sh
set -eu

[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo "Use make e2e-structured-plan" >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$root/tests/support/service-hosts.sh"
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
model="${COMPOSE_PROJECT_NAME}-plan-model"
client="${COMPOSE_PROJECT_NAME}-plan-client"
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
  --network "name=${COMPOSE_PROJECT_NAME}_acp-provider,alias=plan-model" \
  --network "name=${COMPOSE_PROJECT_NAME}_controller-provider,alias=plan-model" \
  -v "$root/tests:/app/tests:ro" \
  antnest/agent-acp-service:local node /app/tests/e2e/acp-plan/model.mjs >/dev/null
# shellcheck disable=SC2086 # service_hosts is a list of options.
docker_cmd create --name "$client" $service_hosts --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_gateway-ingress" --network "${COMPOSE_PROJECT_NAME}_observability" \
  --network "${COMPOSE_PROJECT_NAME}_acp-provider" -e "TEST_RUNTIME_IMAGE=$image" \
  -v "$root/tests:/app/tests:ro" \
  antnest/agent-acp-service:local node /app/tests/e2e/acp-plan/client.mjs >/dev/null
docker_cmd start "$client" >/dev/null
while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ]; do sleep 1; done
status=$(docker_cmd inspect --format '{{.State.ExitCode}}' "$client")
docker_cmd logs "$client"
exit "$status"
