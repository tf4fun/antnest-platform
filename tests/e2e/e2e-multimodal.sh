#!/bin/sh
set -eu

[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo "Use make e2e-multimodal" >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
evidence="$root/artifacts/verification/acp-multimodal/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
umask 077
mkdir -p "$evidence/traces"
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
model="${COMPOSE_PROJECT_NAME}-multimodal-model"
client="${COMPOSE_PROJECT_NAME}-multimodal-client"
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+60000))')
  docker_cmd logs "$client" >"$evidence/client.json" 2>"$evidence/client.stderr" || true
  docker_cmd rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
node "$root/tests/e2e/acp-multimodal/deployment.mjs" inspect-stack
node "$root/tests/e2e/acp-multimodal/deployment.mjs" create-harness
docker_cmd start "$client" >/dev/null
node "$root/tests/e2e/acp-multimodal/deployment.mjs" inspect-runtimes
while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ]; do sleep 1; done
status=$(docker_cmd inspect --format '{{.State.ExitCode}}' "$client")
docker_cmd logs "$client" >"$evidence/client.json" 2>"$evidence/client.stderr"
cat "$evidence/client.json"
exit "$status"
