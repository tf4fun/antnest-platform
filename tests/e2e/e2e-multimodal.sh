#!/bin/sh
set -eu

[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo "Use make e2e-multimodal" >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
model="${COMPOSE_PROJECT_NAME}-multimodal-model"
client="${COMPOSE_PROJECT_NAME}-multimodal-client"
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
image=$(docker_cmd image inspect --format '{{.Id}}' antnest/antnest-runtime:local)
docker_cmd run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "name=${COMPOSE_PROJECT_NAME}_acp-provider,alias=acp-closeout-model" \
  --network "name=${COMPOSE_PROJECT_NAME}_controller-provider,alias=acp-closeout-model" \
  -v "$root/tests:/app/tests:ro" \
  antnest/agent-acp-service:local node /app/tests/e2e/acp-multimodal/model.mjs >/dev/null
docker_cmd create --name "$client" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_gateway-ingress" --network "${COMPOSE_PROJECT_NAME}_observability" \
  --network "${COMPOSE_PROJECT_NAME}_acp-provider" -e "TEST_RUNTIME_IMAGE=$image" \
  -v "$root/tests:/app/tests:ro" \
  antnest/agent-acp-service:local node /app/tests/e2e/acp-multimodal/client.mjs >/dev/null
docker_cmd start "$client" >/dev/null
while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ]; do sleep 1; done
status=$(docker_cmd inspect --format '{{.State.ExitCode}}' "$client")
docker_cmd logs "$client"
exit "$status"
