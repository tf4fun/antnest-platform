#!/bin/sh
set -eu

# The parent owns Compose, Runtime and candidate-image cleanup.
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo "Use make e2e-tool-permissions" >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
evidence="$root/artifacts/verification/acp-permissions/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
umask 077
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
. "$root/tests/e2e/acp-closeout/container-state.sh"
client="${COMPOSE_PROJECT_NAME}-permission-client"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+600000))')
  node "$root/tests/e2e/acp-permissions/deployment.mjs" cleanup-harness || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node "$root/tests/e2e/acp-permissions/deployment.mjs" inspect-stack
node "$root/tests/e2e/acp-permissions/deployment.mjs" create-harness
docker_cmd start "$client" >/dev/null
node "$root/tests/e2e/acp-permissions/deployment.mjs" inspect-runtimes || exit 1
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
