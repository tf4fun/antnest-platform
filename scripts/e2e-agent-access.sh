#!/bin/sh
set -eu
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Disposable parent required' >&2; exit 1; }
[ "${ANTNEST_E2E_KEEP_STACK:-false}" = false ] || { echo 'Retained stacks cannot be used' >&2; exit 1; }
case "${COMPOSE_PROJECT_NAME:-}" in
  antnest-stage3-e2e-[0-9]*) ;;
  *) echo 'Unexpected test project' >&2; exit 1 ;;
esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker() { node "$root/scripts/acp-closeout/docker.mjs" "$@"; }
directory=$(mktemp -d "${TMPDIR:-/tmp}/antnest-agent-access.XXXXXX")
client="${COMPOSE_PROJECT_NAME}-agent-access-client"
model="${COMPOSE_PROJECT_NAME}-agent-access-model"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+90000))')
  if [ "$status" -ne 0 ]; then docker logs --tail=5 "$client" >&2 || true; fi
  docker rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  rm -rf -- "${directory:?}"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --rm --network "${COMPOSE_PROJECT_NAME}_development" \
  --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  -v "$root/scripts/identity-closeout:/fixture:ro" \
  node:24-bookworm-slim node /fixture/access-seed.mjs > "$directory/seed.json"
docker run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" --network-alias agent-access-model \
  -v "$root/scripts/identity-closeout:/app/identity-closeout:ro" \
  antnest/agent-acp-service:local node /app/identity-closeout/agent-access-model.mjs >/dev/null
docker create --name "$client" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" \
  -e "TEST_ACP_DATABASE_URL=postgres://antnest_agent_acp:${ANTNEST_AGENT_ACP_POSTGRES_PASSWORD:-antnest-agent-acp-dev}@postgres:5432/antnest_agent_acp" \
  -v "$root/scripts:/app/closeout-scripts:ro" -v "$directory/seed.json:/fixture-seed.json:ro" \
  antnest/agent-acp-service:local node /app/closeout-scripts/identity-closeout/agent-access-client.mjs >/dev/null
docker network connect "${COMPOSE_PROJECT_NAME}_agent-acp-database" "$client"
docker start "$client" >/dev/null
attempt=0
while [ "$(docker inspect --format '{{.State.Running}}' "$client")" = true ]; do
  attempt=$((attempt+1))
  [ "$attempt" -le 600 ] || { echo 'Agent access test deadline exceeded' >&2; exit 1; }
  sleep 1
done
[ "$(docker inspect --format '{{.State.ExitCode}}' "$client")" = 0 ]
docker logs "$client"
