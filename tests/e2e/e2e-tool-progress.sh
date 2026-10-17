#!/bin/sh
set -eu

# The parent owns Compose, Runtime and candidate-image cleanup.
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo "Use make e2e-tool-progress" >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
evidence="$root/artifacts/verification/acp-progress/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
umask 077
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
. "$root/tests/e2e/acp-closeout/container-state.sh"
model="${COMPOSE_PROJECT_NAME}-progress-model"
client="${COMPOSE_PROJECT_NAME}-progress-client"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+60000))')
  node "$root/tests/e2e/acp-progress/deployment.mjs" cleanup-harness || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node "$root/tests/e2e/acp-progress/deployment.mjs" inspect-stack
node "$root/tests/e2e/acp-progress/deployment.mjs" create-harness
docker_cmd start "$client" >/dev/null
host_status=0
node "$root/tests/e2e/acp-progress/deployment.mjs" serve-gates || host_status=$?
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
[ "$host_status" -eq 0 ] || status=1
exit "$status"
