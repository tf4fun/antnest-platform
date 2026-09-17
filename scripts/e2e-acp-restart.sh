#!/bin/sh
set -eu
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || exit 1
[ "${ANTNEST_E2E_KEEP_STACK:-false}" = false ] || exit 1
case "${COMPOSE_PROJECT_NAME:-}" in antnest-stage3-e2e-[0-9]*) ;; *) exit 1 ;; esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/scripts/acp-closeout/docker.mjs" "$@"; }
acp=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter label=com.docker.compose.service=agent-acp-service)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/antnest-restart.XXXXXX")
chmod 777 "$temporary"
client="${COMPOSE_PROJECT_NAME}-restart-client"
model="${COMPOSE_PROJECT_NAME}-restart-model"
umask 077
evidence="$root/.cache/acp-restart/$COMPOSE_PROJECT_NAME"
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
node "$root/scripts/acp-persistence/process.mjs" owned "$temporary/acp-initial.json"
containers=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
docker_cmd inspect $containers >"$temporary/deployment.json"
node "$root/scripts/stage3-base/deployment.mjs" "$temporary/deployment.json" "$COMPOSE_PROJECT_NAME"

image=$(docker_cmd image inspect --format '{{.Id}}' antnest/antnest-runtime:local)
docker_cmd run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" --network "${COMPOSE_PROJECT_NAME}_development" --network-alias restart-model-peer -v "$root/scripts:/app/scripts:ro" antnest/agent-acp-service:local node /app/scripts/acp-restart/model.mjs >/dev/null
docker_cmd create --name "$client" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" --network "${COMPOSE_PROJECT_NAME}_development" -e "TEST_RUNTIME_IMAGE=$image" -v "$root/scripts:/app/scripts:ro" -v "$temporary:/checkpoints" antnest/agent-acp-service:local node /app/scripts/acp-restart/client.mjs >/dev/null
docker_cmd start "$client" >/dev/null
for step in 1 2 3 4 5 6 7 8; do
  attempt=0
  until [ -f "$temporary/request-$step" ]; do
    [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ] || { docker_cmd logs "$client"; exit 1; }
    attempt=$((attempt+1)); [ "$attempt" -le 180 ] || exit 1
    sleep 1
  done
  docker_cmd inspect "$acp" >"$temporary/before-$step.json"
  node "$root/scripts/acp-persistence/process.mjs" owned "$temporary/before-$step.json"
  node "$root/scripts/acp-closeout/inflight-barrier.mjs" "$temporary/request-$step" >"$temporary/proof-$step"
  chmod 644 "$temporary/proof-$step"
  docker_cmd kill --signal KILL "$acp" >/dev/null
  attempt=0
  while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$acp")" = true ]; do
    attempt=$((attempt+1)); [ "$attempt" -le 60 ] || { echo 'ACP SIGKILL did not settle' >&2; exit 1; }
    sleep 1
  done
  docker_cmd inspect "$acp" >"$temporary/stopped-$step.json"
  node "$root/scripts/acp-restart/process.mjs" "$temporary/before-$step.json" "$temporary/stopped-$step.json"
  docker_cmd start "$acp" >/dev/null
  attempt=0
  until [ "$(docker_cmd inspect --format '{{.State.Health.Status}}' "$acp")" = healthy ]; do
    attempt=$((attempt+1)); [ "$attempt" -le 60 ] || exit 1
    sleep 1
  done
  docker_cmd inspect "$acp" >"$temporary/after-$step.json"
  node "$root/scripts/acp-persistence/process.mjs" restarted "$temporary/before-$step.json" "$temporary/after-$step.json"
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
      node "$root/scripts/acp-closeout/inflight-barrier.mjs" "$temporary/proof-$step" retired
      touch "$temporary/retired-$step"
      ;;
  esac
done
while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ]; do sleep 1; done
status=$(docker_cmd inspect --format '{{.State.ExitCode}}' "$client")
docker_cmd logs "$client"
if docker_cmd cp "$client:/tmp/restart-business.json" "$temporary/business.json" >/dev/null 2>&1; then
  node -e 'const a=require("node:assert/strict"),b=require(process.argv[1]);a.equal(b.status,"business_passed");a.equal(b.deleted,true);' "$temporary/business.json"
  [ -z "$(docker_cmd ps -aq --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME")" ] || exit 1
  [ -z "$(docker_cmd volume ls -q --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME")" ] || exit 1
  echo '{"status":"deletion_resources_passed","runtime_containers":0,"runtime_volumes":0}'
else
  [ "$status" != 0 ] || status=1
fi
exit "$status"
