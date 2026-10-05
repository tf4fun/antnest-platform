#!/bin/sh
set -eu
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Disposable parent required' >&2; exit 1; }
[ "${ANTNEST_E2E_KEEP_STACK:-false}" = false ] || { echo 'Retained stacks cannot receive faults' >&2; exit 1; }
case "${COMPOSE_PROJECT_NAME:-}" in
  antnest-stage3-e2e-[0-9]*) ;;
  *) echo 'Unexpected test project' >&2; exit 1 ;;
esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
evidence="$root/artifacts/verification/identity-session/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
compose() {
  if [ "$1" = up ]; then lifecycle=--lifecycle; else lifecycle=; fi
  docker $lifecycle compose --env-file /dev/null -f compose.yaml -f compose.debug.yaml -f compose.stage3.yaml -f tests/e2e/identity-closeout/oidc-compose.yaml \
    -f tests/e2e/identity-closeout/compose.yaml --profile stage3 --profile observability "$@"
}
identity=$(compose ps -q identity-service)
[ -n "${ANTNEST_E2E_RUN_ID:-}" ] || exit 1
[ "$(docker inspect --format '{{index .Config.Labels "io.antnest.e2e-run-id"}}' "$identity")" = "$ANTNEST_E2E_RUN_ID" ]
[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$identity")" = "$COMPOSE_PROJECT_NAME" ]
umask 077
mkdir -p "$evidence/traces"
containers=$(docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
docker inspect $containers >"$evidence/deployment.private.json"
node "$root/tests/e2e/identity-closeout/deployment.mjs" "$evidence/deployment.private.json" "$COMPOSE_PROJECT_NAME"
checkpoints=$(mktemp -d "${TMPDIR:-/tmp}/antnest-session-checkpoints.XXXXXX")
chmod 777 "$checkpoints"
client="${COMPOSE_PROJECT_NAME}-acp-session-client"
model="${COMPOSE_PROJECT_NAME}-acp-session-model"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+150000))')
  docker logs "$client" >"$evidence/client.json" 2>"$evidence/client.stderr" || true
  docker rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  rm -rf -- "${checkpoints:?}"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" --network-alias acp-session-model \
  -v "$root/tests/e2e/identity-closeout:/app/identity-closeout:ro" \
  antnest/agent-acp-service:local node /app/identity-closeout/acp-session-model.mjs >/dev/null
docker create --name "$client" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_development" \
  -e "TEST_ACP_DATABASE_URL=postgres://antnest_agent_acp:${ANTNEST_AGENT_ACP_POSTGRES_PASSWORD:-antnest-agent-acp-dev}@postgres:5432/antnest_agent_acp" \
  -e "ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF=$ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF" \
  -e ANTNEST_IDENTITY_EVIDENCE_DIR=/evidence/traces \
  -v "$evidence:/evidence" -v "$root/tests:/app/tests:ro" -v "$checkpoints:/checkpoints" \
  antnest/agent-acp-service:local node /app/tests/e2e/identity-closeout/acp-session-fault-client.mjs >/dev/null
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
       compose up -d --wait --no-deps --no-build --pull never identity-service >/dev/null ;;
    3) export ANTNEST_IDENTITY_ACCESS_TOKEN_TTL=12h
       compose up -d --wait --no-deps --no-build --pull never identity-service >/dev/null ;;
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
status=$(docker inspect --format '{{.State.ExitCode}}' "$client")
docker logs "$client" >"$evidence/client.json" 2>"$evidence/client.stderr"
case "$status" in
  0|2) node -e 'const fs=require("node:fs"),assert=require("node:assert/strict");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));assert.equal(r.status,"business_passed");console.log(JSON.stringify(r));' "$evidence/client.json" ;;
  *) echo 'ACP session business/topology failed; diagnostics retained privately' >&2 ;;
esac
exit "$status"
