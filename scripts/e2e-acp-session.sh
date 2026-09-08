#!/bin/sh
set -eu
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Disposable parent required' >&2; exit 1; }
[ "${ANTNEST_E2E_KEEP_STACK:-false}" = false ] || { echo 'Retained stacks cannot receive faults' >&2; exit 1; }
case "${COMPOSE_PROJECT_NAME:-}" in
  antnest-stage3-e2e-[0-9]*) ;;
  *) echo 'Unexpected test project' >&2; exit 1 ;;
esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker() { node "$root/scripts/acp-closeout/docker.mjs" "$@"; }
compose() {
  docker compose -f compose.yaml -f compose.stage3.yaml -f scripts/identity-closeout/oidc-compose.yaml \
    -f scripts/identity-closeout/acp-session-compose.yaml --profile stage3 --profile stage3-e2e --profile observability "$@"
}
identity=$(compose ps -q identity-service)
[ -n "${ANTNEST_E2E_RUN_ID:-}" ] || exit 1
[ "$(docker inspect --format '{{index .Config.Labels "io.antnest.e2e-run-id"}}' "$identity")" = "$ANTNEST_E2E_RUN_ID" ]
[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$identity")" = "$COMPOSE_PROJECT_NAME" ]
checkpoints=$(mktemp -d "${TMPDIR:-/tmp}/antnest-session-checkpoints.XXXXXX")
chmod 777 "$checkpoints"
client="${COMPOSE_PROJECT_NAME}-acp-session-client"
model="${COMPOSE_PROJECT_NAME}-acp-session-model"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+150000))')
  if [ "$status" -ne 0 ]; then docker logs --tail=10 "$client" >&2 || true; fi
  docker rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  rm -rf -- "${checkpoints:?}"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" --network-alias acp-session-model \
  -v "$root/scripts/identity-closeout:/app/identity-closeout:ro" \
  antnest/agent-acp-service:local node /app/identity-closeout/acp-session-model.mjs >/dev/null
docker create --name "$client" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" \
  -e "TEST_ACP_DATABASE_URL=postgres://antnest_agent_acp:${ANTNEST_AGENT_ACP_POSTGRES_PASSWORD:-antnest-agent-acp-dev}@postgres:5432/antnest_agent_acp" \
  -v "$root/scripts:/app/closeout-scripts:ro" -v "$checkpoints:/checkpoints" \
  antnest/agent-acp-service:local node /app/closeout-scripts/identity-closeout/acp-session-fault-client.mjs >/dev/null
docker network connect "${COMPOSE_PROJECT_NAME}_agent-acp-database" "$client"
docker start "$client" >/dev/null
for step in 1 2 3; do
  attempt=0
  until [ -f "$checkpoints/request-$step" ]; do
    [ "$(docker inspect --format '{{.State.Running}}' "$client")" = true ] || exit 1
    attempt=$((attempt + 1))
    [ "$attempt" -le 180 ] || { echo "Checkpoint $step timeout" >&2; exit 1; }
    sleep 1
  done
  case "$step" in
    1) compose stop identity-service >/dev/null ;;
    2) export ANTNEST_IDENTITY_ACCESS_TOKEN_TTL=5s
       compose up -d --wait --no-deps identity-service >/dev/null ;;
    3) export ANTNEST_IDENTITY_ACCESS_TOKEN_TTL=12h
       compose up -d --wait --no-deps identity-service >/dev/null ;;
  esac
  touch "$checkpoints/done-$step"
  printf 'ACP session identity checkpoint %s/3 complete\n' "$step" >&2
done
attempt=0
while [ "$(docker inspect --format '{{.State.Running}}' "$client")" = true ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -le 240 ] || { echo 'ACP session client did not finish' >&2; exit 1; }
  sleep 1
done
[ "$(docker inspect --format '{{.State.ExitCode}}' "$client")" = 0 ]
docker logs "$client"
