#!/bin/sh
set -eu
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || exit 1
[ "${ANTNEST_E2E_KEEP_STACK:-false}" = false ] || exit 1
case "${COMPOSE_PROJECT_NAME:-}" in antnest-stage3-e2e-[0-9]*) ;; *) exit 1 ;; esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
evidence="$root/artifacts/verification/acp-persistence/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
acp=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter label=com.docker.compose.service=agent-acp-service)
temporary=$(mktemp -d "${TMPDIR:-/tmp}/antnest-persistence.XXXXXX")
chmod 777 "$temporary"
client="${COMPOSE_PROJECT_NAME}-persistence-client"
model="${COMPOSE_PROJECT_NAME}-persistence-model"
umask 077
mkdir -p "$evidence"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+90000))')
  docker_cmd logs "$client" >"$evidence/client.log" 2>&1 || true
  docker_cmd cp "$client:/tmp/persistence-traces" "$evidence/" >/dev/null 2>&1 || true
  docker_cmd cp "$client:/tmp/persistence-business.json" "$evidence/" >/dev/null 2>&1 || true
  cp "$temporary"/*.json "$evidence/" 2>/dev/null || true
  docker_cmd rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  rm -rf "$temporary"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker_cmd inspect "$acp" >"$temporary/acp-initial.json"
node "$root/tests/e2e/acp-persistence/process.mjs" owned "$temporary/acp-initial.json"
containers=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
docker_cmd inspect $containers >"$temporary/deployment.json"
node --input-type=module - "$temporary/deployment.json" "$COMPOSE_PROJECT_NAME" <<'JS'
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {inspectDeployment} from './tests/e2e/stage3-base/deployment.mjs';
const rows=JSON.parse(readFileSync(process.argv[2])),proxy=rows.filter(r=>r.Config.Labels['com.docker.compose.service']==='persistence-proxy');assert.equal(proxy.length,1);assert.equal(proxy[0].State.Health.Status,'healthy');assert.equal(proxy[0].Config.Labels['com.docker.compose.project'],process.argv[3]);assert.deepEqual(Object.values(proxy[0].HostConfig.PortBindings??{}).flat(),[]);console.log(JSON.stringify({...inspectDeployment(rows.filter(r=>r!==proxy[0]),process.argv[3]),services:rows.length,private_database_proxy:true}));
JS
image=antnest/antnest-runtime:local
docker_cmd image inspect "$image" >/dev/null
docker_cmd run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" --network "name=${COMPOSE_PROJECT_NAME}_acp-provider,alias=persistence-model-peer" --network "name=${COMPOSE_PROJECT_NAME}_controller-provider,alias=persistence-model-peer" -v "$root/tests:/app/tests:ro" antnest/agent-acp-service:local node /app/tests/e2e/acp-persistence/model.mjs >/dev/null
docker_cmd create --name "$client" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" --network "${COMPOSE_PROJECT_NAME}_gateway-ingress" --network "${COMPOSE_PROJECT_NAME}_observability" --network "${COMPOSE_PROJECT_NAME}_acp-provider" --network "${COMPOSE_PROJECT_NAME}_controller-runtime" --network "${COMPOSE_PROJECT_NAME}_agent-acp-database" \
  --user "$ANTNEST_SERVICE_AUTH_UID:$ANTNEST_SERVICE_AUTH_GID" -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/agent-controller/tokens/runtime-controller:/run/auth/controller-runtime:ro" \
  -e "TEST_RUNTIME_IMAGE=$image" -v "$root/tests:/app/tests:ro" -v "$temporary:/checkpoints" antnest/agent-acp-service:local node /app/tests/e2e/acp-persistence/client.mjs >/dev/null
docker_cmd start "$client" >/dev/null
for step in 1 2 3 4 5 6; do
  attempt=0
  until [ -f "$temporary/request-$step" ]; do
    [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ] || { docker_cmd logs "$client"; exit 1; }
    attempt=$((attempt+1)); [ "$attempt" -le 180 ] || exit 1
    sleep 1
  done
  docker_cmd inspect "$acp" >"$temporary/before-$step.json"
  node "$root/tests/e2e/acp-persistence/process.mjs" owned "$temporary/before-$step.json"
  touch "$temporary/observing-$step"
  attempt=0
  while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$acp")" = true ]; do
    attempt=$((attempt+1)); [ "$attempt" -le 60 ] || { echo 'ACP did not naturally fail-stop' >&2; exit 1; }
    sleep 1
  done
  docker_cmd inspect "$acp" >"$temporary/stopped-$step.json"
  node "$root/tests/e2e/acp-persistence/process.mjs" stopped "$temporary/before-$step.json" "$temporary/stopped-$step.json"
  docker_cmd start "$acp" >/dev/null
  attempt=0
  until [ "$(docker_cmd inspect --format '{{.State.Health.Status}}' "$acp")" = healthy ]; do
    attempt=$((attempt+1)); [ "$attempt" -le 60 ] || exit 1
    sleep 1
  done
  docker_cmd inspect "$acp" >"$temporary/after-$step.json"
  node "$root/tests/e2e/acp-persistence/process.mjs" restarted "$temporary/before-$step.json" "$temporary/after-$step.json"
  touch "$temporary/done-$step"
  echo "ACP persistence fault $step/6: natural exit 1, same container restarted healthy" >&2
done
while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ]; do sleep 1; done
status=$(docker_cmd inspect --format '{{.State.ExitCode}}' "$client")
docker_cmd logs "$client"
if docker_cmd cp "$client:/tmp/persistence-business.json" "$temporary/business.json" >/dev/null 2>&1; then
  node -e 'const a=require("node:assert/strict"),b=require(process.argv[1]);a.equal(b.status,"business_passed");a.equal(b.deleted,true);' "$temporary/business.json"
  [ -z "$(docker_cmd ps -aq --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME")" ] || exit 1
  [ -z "$(docker_cmd volume ls -q --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME")" ] || exit 1
  echo '{"status":"deletion_resources_passed","runtime_containers":0,"runtime_volumes":0}'
else
  [ "$status" != 0 ] || status=1
fi
exit "$status"
