#!/bin/sh
set -eu
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Disposable parent required' >&2; exit 1; }
case "${COMPOSE_PROJECT_NAME:-}" in antnest-stage3-e2e-[0-9]*) ;; *) exit 1 ;; esac
case "${ANTNEST_IDENTITY_SUITE:-}" in core|access) ;; *) exit 1 ;; esac
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
umask 077
temporary=$(mktemp -d "${TMPDIR:-/tmp}/antnest-identity-http.XXXXXX")
evidence="$root/.cache/identity-http/$COMPOSE_PROJECT_NAME"
mkdir -p "$evidence"
export ANTNEST_IDENTITY_EVIDENCE_DIR="$evidence/traces"
docker_cmd() { node "$root/scripts/acp-closeout/docker.mjs" "$@"; }
compose() {
  if [ "$1" = up ]; then lifecycle=--lifecycle; else lifecycle=; fi
  docker_cmd $lifecycle compose --env-file /dev/null -f "$root/compose.yaml" -f "$root/compose.stage3.yaml" \
    -f "$root/scripts/identity-closeout/oidc-compose.yaml" -f "$root/scripts/identity-closeout/compose.yaml" \
    --profile stage3 --profile observability "$@"
}
cleanup() { status=$?; trap - EXIT INT TERM; rm -rf -- "${temporary:?}"; exit "$status"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
containers=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
docker_cmd inspect $containers >"$temporary/deployment.json"
node "$root/scripts/identity-closeout/deployment.mjs" "$temporary/deployment.json" "$COMPOSE_PROJECT_NAME"
strict_status=0
run_suite() {
  suite=$1; shift
  status=0
  node "$@" >"$evidence/$suite.json" 2>"$evidence/$suite.stderr" || status=$?
  case "$status" in
    0|2)
      node -e 'const assert=require("node:assert/strict"); const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); assert.equal(r.status,"business_passed"); console.log(JSON.stringify(r));' "$evidence/$suite.json"
      [ "$status" = 0 ] || strict_status=2 ;;
    *) echo "Identity $suite failed; diagnostics retained privately" >&2; exit 1 ;;
  esac
}
gateway="http://127.0.0.1:$ANTNEST_EDGE_HOST_PORT"
jaeger="http://127.0.0.1:$ANTNEST_JAEGER_UI_HOST_PORT"
if [ "$ANTNEST_IDENTITY_SUITE" = core ]; then
  run_suite local-scim "$root/scripts/identity-closeout/client.mjs" "$gateway" "$jaeger"
  docker_cmd cp "$COMPOSE_PROJECT_NAME-oidc-fixture-1:/certs/tls.crt" "$temporary/tls.crt" >/dev/null
  run_suite oidc "$root/scripts/identity-closeout/oidc-client.mjs" "$gateway" "$jaeger" "$ANTNEST_OIDC_TEST_PORT" "$temporary/tls.crt" "$temporary/canaries.json"
  compose logs --no-color edge-gateway admin-console identity-service >"$temporary/service-logs.txt"
  node "$root/scripts/identity-closeout/check-oidc-logs.mjs" "$temporary/canaries.json" "$temporary/service-logs.txt"
else
  docker_cmd run --rm --network "${COMPOSE_PROJECT_NAME}_development" \
    --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    -v "$root/scripts/identity-closeout:/fixture:ro" \
    node:24-bookworm-slim node /fixture/access-seed.mjs >"$temporary/seed.json"
  run_suite access "$root/scripts/identity-closeout/access-client.mjs" "$gateway" "$jaeger" "$temporary/seed.json"
  node "$root/scripts/identity-closeout/expiry-client.mjs" "$gateway" "$jaeger" prepare "$temporary/expiry.json"
  compose stop identity-service >/dev/null
  node "$root/scripts/identity-closeout/expiry-client.mjs" "$gateway" "$jaeger" unavailable "$temporary/expiry.json"
  export ANTNEST_IDENTITY_ACCESS_TOKEN_TTL=5s
  compose up -d --wait --no-deps --no-build --pull never identity-service >/dev/null
  run_suite expiry "$root/scripts/identity-closeout/expiry-client.mjs" "$gateway" "$jaeger" expiry "$temporary/expiry.json"
fi
printf '{"status":"business_and_topology_passed","suite":"identity-%s","strict_exit":%s}\n' "$ANTNEST_IDENTITY_SUITE" "$strict_status"
exit "$strict_status"
