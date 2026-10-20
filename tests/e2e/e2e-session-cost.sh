#!/bin/sh
set -eu

[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo "Use make e2e-session-cost" >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
evidence="$root/artifacts/verification/acp-cost/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
umask 077
mkdir -p "$evidence/traces"
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+1800000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
. "$root/tests/e2e/acp-closeout/container-state.sh"
model="${COMPOSE_PROJECT_NAME}-cost-model"
client="${COMPOSE_PROJECT_NAME}-cost-client"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+60000))')
  docker_cmd logs "$client" >"$evidence/client.json" 2>"$evidence/client.stderr" || true
  docker_cmd logs "$model" >"$evidence/model.json" 2>"$evidence/model.stderr" || true
  docker_cmd rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node "$root/tests/e2e/acp-cost/deployment.mjs" inspect-stack
node "$root/tests/e2e/acp-cost/deployment.mjs" create-harness
docker_cmd start "$client" >/dev/null
node "$root/tests/e2e/acp-cost/deployment.mjs" restart-acp
node "$root/tests/e2e/acp-cost/deployment.mjs" inspect-runtimes
while :; do
  state=$(client_state "$client")
  if [ "$state" != running ]; then
    status=${state#exited:}
    break
  fi
  sleep 1
done
docker_cmd logs "$client" >"$evidence/client.json" 2>"$evidence/client.stderr"
cat "$evidence/client.json"
exit "$status"
