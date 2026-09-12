#!/bin/sh
set -eu
: "${COMPOSE_PROJECT_NAME:?Use an existing current Stage 3 development stack}"
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/scripts/acp-closeout/docker.mjs" "$@"; }
model="${COMPOSE_PROJECT_NAME}-permission-model"
client="${COMPOSE_PROJECT_NAME}-permission-client"
cleaner="${COMPOSE_PROJECT_NAME}-permission-cleanup"
run_id=$(node -e 'process.stdout.write(crypto.randomUUID())')
printf 'Permission acceptance run: %s\n' "$run_id"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+300000))')
  docker_cmd rm -f "$client" >/dev/null 2>&1 || status=1
  docker_cmd --lifecycle run --rm --name "$cleaner" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --network "${COMPOSE_PROJECT_NAME}_development" -e "TEST_PERMISSION_RUN_ID=$run_id" \
    -v "$root/scripts:/app/scripts:ro" antnest/agent-acp-service:local node /app/scripts/acp-permissions/cleanup.mjs || status=1
  docker_cmd rm -f "$cleaner" "$model" >/dev/null 2>&1 || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
image=$(docker_cmd image inspect --format '{{.Id}}' antnest/antnest-runtime:managed-integration)
docker_cmd run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" --network-alias permission-model \
  -v "$root/scripts:/app/scripts:ro" antnest/agent-acp-service:local node /app/scripts/acp-permissions/model.mjs >/dev/null
docker_cmd create --name "$client" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" -e "TEST_RUNTIME_IMAGE=$image" -e "TEST_BROWSER=${ANTNEST_E2E_BROWSER:-false}" \
  -e "TEST_PERMISSION_RUN_ID=$run_id" -e "TEST_PERMISSION_CRASH=${ANTNEST_E2E_PERMISSION_CRASH:-false}" \
  -v "$root/scripts:/app/scripts:ro" antnest/agent-acp-service:local node /app/scripts/acp-permissions/client.mjs >/dev/null
docker_cmd start "$client" >/dev/null
while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ]; do
  if [ "${ANTNEST_E2E_PERMISSION_CRASH:-false}" = true ]; then
    case "$(docker_cmd logs "$client")" in
      *'"status":"crash_ready"'*) docker_cmd kill "$client" >/dev/null ;;
    esac
  fi
  sleep 1
done
status=$(docker_cmd inspect --format '{{.State.ExitCode}}' "$client")
docker_cmd logs "$client"
exit "$status"
