#!/bin/sh
set -eu
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Disposable parent required' >&2; exit 1; }
[ "${ANTNEST_E2E_KEEP_STACK:-false}" = false ] || exit 1
case "${COMPOSE_PROJECT_NAME:-}" in antnest-stage3-e2e-[0-9]*) ;; *) exit 1 ;; esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
umask 077
evidence="$root/artifacts/verification/acp-closeout-normal/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
mkdir -p "$evidence/traces"
client="${COMPOSE_PROJECT_NAME}-closeout-access-client"
model="${COMPOSE_PROJECT_NAME}-closeout-access-model"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+90000))')
  docker_cmd logs "$client" >"$evidence/client.json" 2>"$evidence/client.stderr" || true
  docker_cmd logs "$model" >"$evidence/model.private.log" 2>&1 || true
  docker_cmd rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
containers=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
docker_cmd inspect $containers >"$evidence/deployment.private.json"
node "$root/tests/e2e/identity-closeout/deployment.mjs" "$evidence/deployment.private.json" "$COMPOSE_PROJECT_NAME"
docker_cmd run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" --network-alias closeout-access-model \
  -v "$root/tests:/app/tests:ro" antnest/agent-acp-service:local \
  node /app/tests/e2e/acp-closeout/access-model.mjs >/dev/null
docker_cmd create --name "$client" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" \
  -e "TEST_ACP_DATABASE_URL=postgres://antnest_agent_acp:${ANTNEST_AGENT_ACP_POSTGRES_PASSWORD:-antnest-agent-acp-dev}@postgres:5432/antnest_agent_acp" \
  -e "ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF=$ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF" \
  -e ANTNEST_IDENTITY_EVIDENCE_DIR=/evidence/traces \
  -v "$evidence:/evidence" -v "$root/tests:/app/tests:ro" \
  antnest/agent-acp-service:local node /app/tests/e2e/acp-closeout/access-client.mjs >/dev/null
docker_cmd network connect "${COMPOSE_PROJECT_NAME}_agent-acp-database" "$client"
docker_cmd network connect "$ANTNEST_RUNTIME_MANAGEMENT_NETWORK" "$client"
docker_cmd start "$client" >/dev/null
attempt=0
while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ]; do
  attempt=$((attempt+1)); [ "$attempt" -le 750 ] || { echo 'ACP access client deadline exceeded' >&2; exit 1; }
  sleep 1
done
status=$(docker_cmd inspect --format '{{.State.ExitCode}}' "$client")
docker_cmd logs "$client" >"$evidence/client.json" 2>"$evidence/client.stderr"
case "$status" in
  0|2) node -e 'const fs=require("node:fs"),a=require("node:assert/strict");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));a.equal(r.status,"business_passed");console.log(JSON.stringify(r));' "$evidence/client.json" ;;
  *) echo 'ACP access business/topology failed; private diagnostics retained' >&2 ;;
esac
exit "$status"
