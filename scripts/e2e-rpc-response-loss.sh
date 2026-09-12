#!/bin/sh
set -eu

[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Disposable parent required' >&2; exit 1; }
[ "${ANTNEST_E2E_KEEP_STACK:-false}" = false ] || exit 1
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/scripts/acp-closeout/docker.mjs" "$@"; }
. "$root/scripts/acp-closeout/container-state.sh"
acp=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter label=com.docker.compose.service=agent-acp-service)
[ -n "$acp" ] || { echo 'Missing owned ACP container' >&2; exit 1; }
[ "$(docker_cmd inspect --format '{{index .Config.Labels "io.antnest.e2e-run-id"}}' "$acp")" = "$ANTNEST_E2E_RUN_ID" ] || { echo 'ACP invocation ownership mismatch' >&2; exit 1; }
[ "$(docker_cmd inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$acp")" = no ] || { echo 'ACP must not auto-restart in this fault profile' >&2; exit 1; }
checkpoints=$(mktemp -d "${TMPDIR:-/tmp}/antnest-rpc-checkpoints.XXXXXX")
chmod 777 "$checkpoints"
client="${COMPOSE_PROJECT_NAME}-rpc-loss-client"
model="${COMPOSE_PROJECT_NAME}-rpc-loss-model"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+60000))')
  if [ "$status" -ne 0 ]; then
    docker_cmd logs --tail=20 "$client" >&2 || true
    echo 'Raw service logs omitted; parent owns resource cleanup.' >&2
  fi
  docker_cmd rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  rm -rf -- "${checkpoints:?}"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
image=$(docker_cmd image inspect --format '{{.Id}}' antnest/antnest-runtime:local)
docker_cmd run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" --network-alias acp-closeout-model \
  -v "$root/scripts:/app/scripts:ro" \
  antnest/agent-acp-service:local node /app/scripts/acp-closeout/rpc-model.mjs >/dev/null
docker_cmd create --name "$client" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" -e "TEST_RUNTIME_IMAGE=$image" \
  -e "TEST_ACP_DATABASE_URL=postgres://antnest_agent_acp:${ANTNEST_AGENT_ACP_POSTGRES_PASSWORD:-antnest-agent-acp-dev}@postgres:5432/antnest_agent_acp" \
  -v "$root/scripts:/app/scripts:ro" -v "$checkpoints:/checkpoints" \
  antnest/agent-acp-service:local node /app/scripts/acp-closeout/rpc-client.mjs >/dev/null
docker_cmd network connect "${COMPOSE_PROJECT_NAME}_agent-acp-database" "$client"
docker_cmd start "$client" >/dev/null
for step in 1 2 3 4; do
  attempt=0
  until [ -f "$checkpoints/request-$step" ]; do
    [ "$(client_state "$client")" = running ] || exit 1
    attempt=$((attempt + 1)); [ "$attempt" -le 180 ] || exit 1
    sleep 1
  done
  previous=$(docker_cmd inspect --format '{{.State.StartedAt}}' "$acp")
  attempt=0
  while [ "$(client_state "$acp")" = running ]; do
    [ "$(client_state "$client")" = running ] || exit 1
    attempt=$((attempt + 1)); [ "$attempt" -le 45 ] || { echo 'ACP did not self-stop' >&2; exit 1; }
    sleep 1
  done
  [ "$(docker_cmd inspect --format '{{.State.Status}}:{{.State.ExitCode}}:{{.State.OOMKilled}}:{{.RestartCount}}' "$acp")" = exited:1:false:0 ]
  docker_cmd start "$acp" >/dev/null
  wait_for_health "$acp"
  [ "$(docker_cmd inspect --format '{{.State.StartedAt}}' "$acp")" != "$previous" ]
  touch "$checkpoints/done-$step"
  printf 'RPC response-loss recovery %s/4: self-exit 1, same container, new ready process\n' "$step" >&2
done
attempt=0
while [ "$(client_state "$client")" = running ]; do
  attempt=$((attempt + 1)); [ "$attempt" -le 120 ] || exit 1
  sleep 1
done
[ "$(client_state "$client")" = exited:0 ]
docker_cmd logs "$client"
