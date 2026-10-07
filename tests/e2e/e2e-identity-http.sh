#!/bin/sh
set -eu
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Disposable parent required' >&2; exit 1; }
case "${COMPOSE_PROJECT_NAME:-}" in antnest-stage3-e2e-[0-9]*) ;; *) exit 1 ;; esac
case "${ANTNEST_IDENTITY_SUITE:-}" in core|access) ;; *) exit 1 ;; esac
case "${ANTNEST_E2E_ORGANIZATION_DISPLAY:-false}" in true|false) ;; *) exit 1 ;; esac
if [ "${ANTNEST_E2E_ORGANIZATION_DISPLAY:-false}" = true ] && [ "$ANTNEST_IDENTITY_SUITE" != core ]; then
  echo 'Organization display integration requires the Identity core profile' >&2
  exit 1
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
evidence="$root/artifacts/verification/identity-http/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
umask 077
temporary=$(mktemp -d "${TMPDIR:-/tmp}/antnest-identity-http.XXXXXX")
mkdir -p "$evidence"
export ANTNEST_IDENTITY_EVIDENCE_DIR="$evidence/traces"
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
compose() {
  if [ "$1" = up ]; then lifecycle=--lifecycle; else lifecycle=; fi
  docker_cmd $lifecycle compose --env-file /dev/null -f "$root/compose.yaml" -f "$root/compose.debug.yaml" -f "$root/compose.stage3.yaml" \
    -f "$root/tests/support/compose.public-development-secrets.yaml" -f "$root/tests/e2e/stage3a.compose.yaml" \
    -f "$root/tests/e2e/identity-closeout/oidc-compose.yaml" -f "$root/tests/e2e/identity-closeout/compose.yaml" \
    --profile stage3 --profile observability "$@"
}
cleanup() { status=$?; trap - EXIT INT TERM; rm -rf -- "${temporary:?}"; exit "$status"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
containers=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
docker_cmd inspect $containers >"$temporary/deployment.json"
node "$root/tests/e2e/identity-closeout/deployment.mjs" "$temporary/deployment.json" "$COMPOSE_PROJECT_NAME"
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
# Identity fixtures sign in as edge-gateway and change the directory as Admin
# Console, with the per-run credentials Identity admits from those callers.
identity_fixture() {
  script=$1; shift
  docker_cmd run --rm --network "${COMPOSE_PROJECT_NAME}_identity-clients" \
    --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --user "$ANTNEST_SERVICE_AUTH_UID:$ANTNEST_SERVICE_AUTH_GID" \
    -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/edge-gateway/tokens/identity-service:/run/auth/gateway-identity:ro" \
    -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/admin-console/tokens/identity-service:/run/auth/console-identity:ro" \
    -v "$root/tests:/app/tests:ro" "$@" \
    node:24.21.0-bookworm-slim node "/app/tests/e2e/identity-closeout/$script"
}
if [ "$ANTNEST_IDENTITY_SUITE" = core ]; then
  identity_fixture principal-client.mjs \
    -e ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG -e ANTNEST_BOOTSTRAP_ORGANIZATION_NAME \
    -e ANTNEST_BOOTSTRAP_ADMIN_EMAIL -e ANTNEST_BOOTSTRAP_ADMIN_PASSWORD \
    >"$evidence/principal.json" 2>"$evidence/principal.stderr"
  node -e 'const assert=require("node:assert/strict"); const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); assert.equal(r.status,"business_passed"); console.log(JSON.stringify(r));' "$evidence/principal.json"
  docker_cmd cp "$COMPOSE_PROJECT_NAME-oidc-fixture-1:/certs/tls.crt" "$temporary/tls.crt" >/dev/null
  if [ "${ANTNEST_E2E_ORGANIZATION_DISPLAY:-false}" = true ]; then
    identity_fixture organization-display-seed.mjs \
      >"$temporary/organization-seed.json" 2>"$evidence/organization-seed.stderr"
    run_suite organization-display "$root/tests/e2e/identity-closeout/organization-display-client.mjs" \
      "$gateway" "$ANTNEST_OIDC_TEST_PORT" "$temporary/tls.crt" "$temporary/organization-seed.json" "$temporary/canaries.json"
  else
    run_suite local-scim "$root/tests/e2e/identity-closeout/client.mjs" "$gateway" "$jaeger"
    run_suite oidc "$root/tests/e2e/identity-closeout/oidc-client.mjs" "$gateway" "$jaeger" "$ANTNEST_OIDC_TEST_PORT" "$temporary/tls.crt" "$temporary/canaries.json"
  fi
  compose logs --no-color edge-gateway admin-console identity-service agent-ui >"$temporary/service-logs.txt"
  node "$root/tests/e2e/identity-closeout/check-oidc-logs.mjs" "$temporary/canaries.json" "$temporary/service-logs.txt"
else
  identity_fixture access-seed.mjs >"$temporary/seed.json"
  run_suite access "$root/tests/e2e/identity-closeout/access-client.mjs" "$gateway" "$jaeger" "$temporary/seed.json"
  node "$root/tests/e2e/identity-closeout/expiry-client.mjs" "$gateway" "$jaeger" prepare "$temporary/expiry.json"
  compose stop identity-service >/dev/null
  node "$root/tests/e2e/identity-closeout/expiry-client.mjs" "$gateway" "$jaeger" unavailable "$temporary/expiry.json"
  export ANTNEST_IDENTITY_ACCESS_TOKEN_TTL=5s
  compose up -d --wait --no-deps --no-build --pull never identity-service >/dev/null
  run_suite expiry "$root/tests/e2e/identity-closeout/expiry-client.mjs" "$gateway" "$jaeger" expiry "$temporary/expiry.json"
fi
suite_label=$ANTNEST_IDENTITY_SUITE
if [ "${ANTNEST_E2E_ORGANIZATION_DISPLAY:-false}" = true ]; then suite_label=organization-display; fi
printf '{"status":"business_and_topology_passed","suite":"identity-%s","strict_exit":%s}\n' "$suite_label" "$strict_status"
exit "$strict_status"
