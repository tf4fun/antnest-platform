#!/bin/sh
set -eu

# Only the fresh parent harness may inject faults. Never target a retained stack.
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Disposable parent required' >&2; exit 1; }
[ "${ANTNEST_E2E_KEEP_STACK:-false}" = false ] || { echo 'Retained stacks cannot receive faults' >&2; exit 1; }
case "${COMPOSE_PROJECT_NAME:-}" in
  antnest-stage3-e2e-[0-9]*) ;;
  *) echo 'Unexpected test project' >&2; exit 1 ;;
esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker() { node "$root/scripts/acp-closeout/docker.mjs" "$@"; }
docker_cmd() { docker "$@"; }
. "$root/scripts/acp-closeout/container-state.sh"
acp=${ANTNEST_E2E_ACP_CONTAINER:?parent ACP container required}
[ -n "${ANTNEST_E2E_RUN_ID:-}" ] || exit 1
[ "$(docker inspect --format '{{index .Config.Labels "io.antnest.e2e-run-id"}}' "$acp")" = "$ANTNEST_E2E_RUN_ID" ]
[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$acp")" = "$COMPOSE_PROJECT_NAME" ]
[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$acp")" = agent-acp-service ]
checkpoints=$(mktemp -d "${TMPDIR:-/tmp}/antnest-acp-checkpoints.XXXXXX")
chmod 777 "$checkpoints"
client="${COMPOSE_PROJECT_NAME}-acp-closeout-client"
model="${COMPOSE_PROJECT_NAME}-acp-closeout-model"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+150000))')
  if [ "$status" -ne 0 ]; then
    docker logs --tail=80 "$client" >&2 || true
    docker logs --tail=80 "$model" >&2 || true
    printf 'Raw ACP service logs omitted; parent harness summarizes diagnostics.\n' >&2
  fi
  docker rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  rm -rf -- "${checkpoints:?}"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" --network-alias acp-closeout-model \
  -v "$root/scripts/acp-closeout:/app/acp-closeout:ro" \
  antnest/agent-acp-service:local node /app/acp-closeout/model.mjs >/dev/null
docker create --name "$client" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" \
  -e "TEST_ACP_DATABASE_URL=postgres://antnest_agent_acp:${ANTNEST_AGENT_ACP_POSTGRES_PASSWORD:-antnest-agent-acp-dev}@postgres:5432/antnest_agent_acp" \
  -v "$root/scripts:/app/closeout-scripts:ro" -v "$checkpoints:/checkpoints" \
  antnest/agent-acp-service:local node /app/closeout-scripts/acp-closeout/client.mjs >/dev/null
# PostgreSQL has no development-network endpoint; add only its ACP-owned network.
docker network connect "${COMPOSE_PROJECT_NAME}_agent-acp-database" "$client"
docker start "$client" >/dev/null

for step in 1 2 3 4 5 6 7 8; do
  attempt=0
  until [ -f "$checkpoints/request-$step" ]; do
    [ "$(docker inspect --format '{{.State.Running}}' "$client")" = true ] || exit 1
    attempt=$((attempt + 1))
    [ "$attempt" -le 180 ] || { echo "Checkpoint $step timeout" >&2; exit 1; }
    sleep 1
  done
  node "$root/scripts/acp-closeout/inflight-barrier.mjs" "$checkpoints/request-$step" >"$checkpoints/proof-$step"
  previous=$(docker inspect --format '{{.State.StartedAt}}' "$acp")
  docker kill --signal KILL "$acp" >/dev/null
  [ "$(docker inspect --format '{{.State.ExitCode}}' "$acp")" = 137 ]
  docker start "$acp" >/dev/null
  attempt=0
  until docker exec "$acp" curl --max-time 3 -fsS http://127.0.0.1:8080/status >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    [ "$attempt" -le 45 ] || { echo 'ACP did not recover readiness' >&2; exit 1; }
    sleep 1
  done
  [ "$(docker inspect --format '{{.State.StartedAt}}' "$acp")" != "$previous" ]
  touch "$checkpoints/done-$step"
  printf 'ACP closeout restart %s/8 verified (SIGKILL 137, new process ready)\n' "$step" >&2
  case "$step" in
    4|8)
      attempt=0
      until [ -f "$checkpoints/retire-request-$step" ]; do
        [ "$(docker inspect --format '{{.State.Running}}' "$client")" = true ] || exit 1
        attempt=$((attempt + 1))
        [ "$attempt" -le 150 ] || { echo 'Rebuild retirement checkpoint timeout' >&2; exit 1; }
        sleep 1
      done
      node "$root/scripts/acp-closeout/inflight-barrier.mjs" "$checkpoints/proof-$step" retired
      touch "$checkpoints/retired-$step"
      ;;
  esac
done
attempt=0
while :; do
  state=$(client_state "$client")
  if [ "$state" != running ]; then
    [ "$state" = exited:0 ] || exit 1
    break
  fi
  attempt=$((attempt + 1))
  [ "$attempt" -le 60 ] || { echo 'ACP client did not settle' >&2; exit 1; }
  sleep 1
done
docker logs "$client"
