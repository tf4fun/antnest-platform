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
  docker $lifecycle compose --env-file /dev/null -f compose.yaml -f compose.debug.yaml -f compose.stage3.yaml -f tests/support/compose.public-development-secrets.yaml \
    -f tests/e2e/stage3a.compose.yaml -f tests/e2e/identity-closeout/oidc-compose.yaml \
    -f tests/e2e/identity-closeout/compose.yaml -f tests/integration/deployment/compose.admission.yaml \
    --profile stage3 --profile observability "$@"
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
node "$root/tests/e2e/identity-closeout/session-deployment.mjs" inspect-stack "$evidence/deployment.private.json"
identity_image_ref=${ANTNEST_E2E_IDENTITY_IMAGE:-antnest/identity-service:local}
identity_image_id=$(docker image inspect --format '{{.Id}}' "$identity_image_ref")
node -e 'const fs=require("node:fs"); const [path,imageRef,imageID,runID]=process.argv.slice(1); fs.writeFileSync(path,JSON.stringify({imageRef,imageID,runID})+"\n",{flag:"wx",mode:0o600});' \
  "$evidence/identity-selection.json" "$identity_image_ref" "$identity_image_id" "$ANTNEST_E2E_RUN_ID"
node "$root/tests/e2e/identity-closeout/deployment.mjs" "$evidence/deployment.private.json" "$COMPOSE_PROJECT_NAME" \
  identity-lifecycle "$identity_image_id" 12h >"$evidence/identity-initial-receipt.json"
checkpoints=$(mktemp -d "${TMPDIR:-/tmp}/antnest-session-checkpoints.XXXXXX")
chmod 777 "$checkpoints"
client="${COMPOSE_PROJECT_NAME}-acp-session-client"
model="${COMPOSE_PROJECT_NAME}-acp-session-model"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+150000))')
  docker logs "$client" >"$evidence/client.json" 2>"$evidence/client.stderr" || true
  compose logs --no-color --tail 200 edge-gateway identity-service >"$evidence/services.private.txt" 2>&1 || true
  docker rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  rm -rf -- "${checkpoints:?}"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node "$root/tests/e2e/identity-closeout/session-deployment.mjs" create-harness "$checkpoints"
docker start "$client" >/dev/null
for step in 1 2 3; do
  attempt=0
  until [ -f "$checkpoints/request-$step" ]; do
    [ "$(docker inspect --format '{{.State.Running}}' "$client")" = true ] || exit 1
    attempt=$((attempt + 1))
    [ "$attempt" -le 180 ] || { echo "Checkpoint $step timeout" >&2; exit 1; }
    sleep 1
  done
  docker inspect "$identity" >"$evidence/identity-step-$step-before.private.json"
  node -e 'console.log(JSON.stringify({observed_at_ms:Date.now()}))' >"$evidence/identity-step-$step-started.json"
  case "$step" in
    1) compose stop identity-service >/dev/null ;;
    2) export ANTNEST_IDENTITY_ACCESS_TOKEN_TTL=5s
       compose up -d --wait --no-deps --no-build --pull never identity-service >/dev/null ;;
    3) export ANTNEST_IDENTITY_ACCESS_TOKEN_TTL=12h
       compose up -d --wait --no-deps --no-build --pull never identity-service >/dev/null ;;
  esac
  node -e 'console.log(JSON.stringify({observed_at_ms:Date.now()}))' >"$evidence/identity-step-$step-returned.json"
  if [ "$step" != 1 ]; then identity=$(compose ps -q identity-service); fi
  [ -n "$identity" ] || { echo 'Identity transition has no resulting container' >&2; exit 1; }
  docker inspect "$identity" >"$evidence/identity-step-$step-after.private.json"
  node "$root/tests/e2e/identity-closeout/deployment.mjs" "$evidence" "$COMPOSE_PROJECT_NAME" \
    identity-session-checkpoint "$checkpoints" "$step" >"$evidence/identity-step-$step-summary.json"
  printf 'ACP session identity checkpoint %s/3 complete\n' "$step" >&2
done
attempt=0
until [ -f "$checkpoints/request-owner-drain" ]; do
  [ "$(docker inspect --format '{{.State.Running}}' "$client")" = true ] || exit 1
  attempt=$((attempt + 1))
  [ "$attempt" -le 180 ] || { echo 'Session owner drain request timeout' >&2; exit 1; }
  sleep 1
done
node "$root/tests/e2e/identity-closeout/session-deployment.mjs" drain-owners "$checkpoints"
attempt=0
while [ "$(docker inspect --format '{{.State.Running}}' "$client")" = true ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -le 240 ] || { echo 'ACP session client did not finish' >&2; exit 1; }
  sleep 1
done
status=$(docker inspect --format '{{.State.ExitCode}}' "$client")
docker logs "$client" >"$evidence/client.json" 2>"$evidence/client.stderr"
case "$status" in
  0|2) node -e 'const fs=require("node:fs"),assert=require("node:assert/strict");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));assert.equal(r.status,"business_passed");console.log(JSON.stringify(r));' "$evidence/client.json"
       node "$root/tests/e2e/identity-closeout/session-deployment.mjs" inspect-runtime "$evidence/client.json" ;;
  *) echo 'ACP session business/topology failed; diagnostics retained privately' >&2 ;;
esac
exit "$status"
