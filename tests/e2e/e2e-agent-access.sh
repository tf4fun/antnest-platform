#!/bin/sh
set -eu
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Disposable parent required' >&2; exit 1; }
[ "${ANTNEST_E2E_KEEP_STACK:-false}" = false ] || { echo 'Retained stacks cannot be used' >&2; exit 1; }
case "${COMPOSE_PROJECT_NAME:-}" in
  antnest-stage3-e2e-[0-9]*) ;;
  *) echo 'Unexpected test project' >&2; exit 1 ;;
esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$root/tests/support/service-hosts.sh"
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
umask 077
evidence="$root/artifacts/verification/identity-agent/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
mkdir -p "$evidence/traces"
compose() {
  docker --lifecycle compose --env-file /dev/null -f "$root/compose.yaml" -f "$root/compose.debug.yaml" -f "$root/compose.stage3.yaml" \
    -f "$root/tests/support/compose.public-development-secrets.yaml" -f "$root/tests/e2e/stage3a.compose.yaml" \
    -f "$root/tests/e2e/identity-closeout/oidc-compose.yaml" -f "$root/tests/e2e/identity-closeout/compose.yaml" \
    --profile stage3 --profile observability "$@"
}
containers=$(docker ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
docker inspect $containers >"$evidence/deployment.private.json"
node "$root/tests/e2e/identity-closeout/deployment.mjs" "$evidence/deployment.private.json" "$COMPOSE_PROJECT_NAME"
directory=$(mktemp -d "${TMPDIR:-/tmp}/antnest-agent-access.XXXXXX")
client="${COMPOSE_PROJECT_NAME}-agent-access-client"
model="${COMPOSE_PROJECT_NAME}-agent-access-model"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+90000))')
  compose logs --no-color edge-gateway admin-console identity-service agent-controller agent-acp-service >"$evidence/services.private.log" 2>/dev/null || true
  docker logs "$client" >"$evidence/client.json" 2>"$evidence/client.stderr" || true
  docker rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  rm -rf -- "${directory:?}"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# The seed signs in as edge-gateway and changes the directory as Admin Console.
docker run --rm --network "${COMPOSE_PROJECT_NAME}_identity-clients" \
  --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --user "$ANTNEST_SERVICE_AUTH_UID:$ANTNEST_SERVICE_AUTH_GID" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/edge-gateway/tokens/identity-service:/run/auth/gateway-identity:ro" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/admin-console/tokens/identity-service:/run/auth/console-identity:ro" \
  -v "$root/tests:/app/tests:ro" \
  node:24.21.0-bookworm-slim node /app/tests/e2e/identity-closeout/access-seed.mjs > "$directory/seed.json"
docker run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "name=${COMPOSE_PROJECT_NAME}_acp-provider,alias=agent-access-model" \
  --network "name=${COMPOSE_PROJECT_NAME}_controller-provider,alias=agent-access-model" \
  -v "$root/tests/e2e/identity-closeout:/app/identity-closeout:ro" \
  antnest/agent-acp-service:local node /app/identity-closeout/agent-access-model.mjs >/dev/null
# shellcheck disable=SC2086 # service_hosts is a list of options.
docker create --name "$client" $service_hosts --user "$ANTNEST_SERVICE_AUTH_UID:$ANTNEST_SERVICE_AUTH_GID" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_gateway-ingress" --network "${COMPOSE_PROJECT_NAME}_observability" \
  --network "${COMPOSE_PROJECT_NAME}_acp-provider" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/agent-controller/tokens/runtime-controller:/run/auth/controller-runtime:ro" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/edge-gateway/tokens/identity-service:/run/auth/gateway-identity:ro" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/admin-console/tokens/agent-controller:/run/auth/console-controller:ro" \
  -e "TEST_ACP_DATABASE_URL=postgres://antnest_agent_acp:${ANTNEST_AGENT_ACP_POSTGRES_PASSWORD:-antnest-agent-acp-dev}@postgres:5432/antnest_agent_acp" \
  -e "TEST_GATEWAY_PUBLIC_URL=$ANTNEST_EDGE_PUBLIC_BASE_URL" \
  -e "ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF=$ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF" \
  -e ANTNEST_IDENTITY_EVIDENCE_DIR=/evidence/traces -v "$evidence:/evidence" \
  -v "${COMPOSE_PROJECT_NAME}-oidc-certs:/test-ca:ro" \
  -v "$directory:/coordination" \
  -v "$root/tests:/app/tests:ro" -v "$directory/seed.json:/fixture-seed.json:ro" \
  antnest/agent-acp-service:local node /app/tests/e2e/identity-closeout/agent-access-client.mjs >/dev/null
docker network connect "${COMPOSE_PROJECT_NAME}_agent-acp-database" "$client"
docker network connect "$ANTNEST_RUNTIME_MANAGEMENT_NETWORK" "$client"
docker network connect "${COMPOSE_PROJECT_NAME}_controller-runtime" "$client"
docker network connect "${COMPOSE_PROJECT_NAME}_identity-clients" "$client"
docker network connect "${COMPOSE_PROJECT_NAME}_controller-clients" "$client"
docker start "$client" >/dev/null
attempt=0
while [ "$(docker inspect --format '{{.State.Running}}' "$client")" = true ]; do
  for checkpoint in controller-offline controller-online; do
    if [ -f "$directory/$checkpoint.request" ] && [ ! -f "$directory/$checkpoint.ack" ]; then
      case "$checkpoint" in
        controller-offline) compose stop agent-controller >/dev/null ;;
        controller-online) compose start --wait agent-controller >/dev/null ;;
      esac
      touch "$directory/$checkpoint.ack"
    fi
  done
  attempt=$((attempt+1))
  [ "$attempt" -le 600 ] || { echo 'Agent access test deadline exceeded' >&2; exit 1; }
  sleep 1
done
status=$(docker inspect --format '{{.State.ExitCode}}' "$client")
docker logs "$client" >"$evidence/client.json" 2>"$evidence/client.stderr"
case "$status" in
  0|2) node -e 'const fs=require("node:fs"),assert=require("node:assert/strict");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));assert.equal(r.status,"business_passed");console.log(JSON.stringify(r));' "$evidence/client.json" ;;
  *) echo 'Agent access business/topology failed; diagnostics retained privately' >&2 ;;
esac
exit "$status"
