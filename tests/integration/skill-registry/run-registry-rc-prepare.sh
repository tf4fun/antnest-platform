#!/usr/bin/env bash
set -euo pipefail

root_dir=$(cd "$(dirname "$0")/../../.." && pwd)
suffix=$$
postgres_name="antnest-skill-prepare-pg-$suffix"
network_name="antnest-skill-prepare-network-$suffix"
runtime_image="antnest/skill-runtime-integration:$suffix"
temp_root=${TMPDIR:-/tmp}
temp_dir=$(mktemp -d "${temp_root%/}/antnest-skill-prepare.XXXXXX")
registry_pid=''
controller_pid=''
proxy_pid=''
test_pid=''

cleanup() {
  if [[ -n "$test_pid" ]]; then kill "$test_pid" 2>/dev/null || true; wait "$test_pid" 2>/dev/null || true; fi
  if [[ -n "$controller_pid" ]]; then kill "$controller_pid" 2>/dev/null || true; wait "$controller_pid" 2>/dev/null || true; fi
  if [[ -n "$proxy_pid" ]]; then kill "$proxy_pid" 2>/dev/null || true; wait "$proxy_pid" 2>/dev/null || true; fi
  if [[ -n "$registry_pid" ]]; then kill "$registry_pid" 2>/dev/null || true; wait "$registry_pid" 2>/dev/null || true; fi
  docker ps -aq --filter "label=io.antnest.runtime-controller-scope=$network_name" |
    while IFS= read -r container; do [[ -z "$container" ]] || docker rm -f "$container" >/dev/null 2>&1 || true; done
  docker volume ls -q --filter "label=io.antnest.runtime-controller-scope=$network_name" |
    while IFS= read -r volume; do [[ -z "$volume" ]] || docker volume rm "$volume" >/dev/null 2>&1 || true; done
  docker image rm "$runtime_image" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
  docker rm -f "$postgres_name" >/dev/null 2>&1 || true
  rm -rf "$temp_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ "${ANTNEST_TEST_RESTART_SKILL_PREPARATION:-false}" == true && "${ANTNEST_TEST_SLOW_SKILL_PREPARATION:-false}" != true ]]; then
  echo 'RC preparation restart requires the slow preparation profile' >&2
  exit 1
fi

export GOCACHE="$root_dir/.cache/go-build" GOMODCACHE="$root_dir/.cache/go-mod" GOPROXY=off
cd "$root_dir"
go build -o "$temp_dir/skill-registry" ./services/skill-registry/cmd/skill-registry
go build -o "$temp_dir/runtime-controller" ./services/runtime-controller/cmd/runtime-controller
docker build --network=none -f tests/integration/skill-registry/runtime-mount.Dockerfile \
  -t "$runtime_image" tests/integration/skill-registry >/dev/null
docker run --rm -d --name "$postgres_name" -e POSTGRES_PASSWORD=antnest_test \
  -p 127.0.0.1::5432 postgres:17.11-bookworm >/dev/null
pg_port=$(docker port "$postgres_name" 5432/tcp | sed 's/.*://')
for _ in $(seq 1 30); do
  if docker exec "$postgres_name" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker network create "$network_name" >/dev/null
registry_port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
controller_port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
export ANTNEST_SKILL_REGISTRY_API_TOKEN=antnest-skill-registry-isolated-integration-token
export ANTNEST_TEST_REGISTRY_URL="http://127.0.0.1:$registry_port"
export ANTNEST_TEST_RUNTIME_CONTROLLER_URL="http://127.0.0.1:$controller_port"
export ANTNEST_RUNTIME_CONTROLLER_SCOPE="$network_name"
export ANTNEST_TEST_RUNTIME_IMAGE="$runtime_image"
export ANTNEST_DOCKER_HOST=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
export OTEL_SDK_DISABLED=true
ANTNEST_SKILL_REGISTRY_LISTEN="127.0.0.1:$registry_port" \
  ANTNEST_SKILL_REGISTRY_DATABASE_URL="postgres://postgres:antnest_test@127.0.0.1:$pg_port/postgres?sslmode=disable" \
  "$temp_dir/skill-registry" >"$temp_dir/registry.log" 2>&1 &
registry_pid=$!
registry_for_controller="$ANTNEST_TEST_REGISTRY_URL"
if [[ "${ANTNEST_TEST_SLOW_SKILL_PREPARATION:-false}" == true ]]; then
  proxy_port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
  export ANTNEST_TEST_SLOW_PROXY_URL="http://127.0.0.1:$proxy_port"
  ANTNEST_TEST_REGISTRY_UPSTREAM="$ANTNEST_TEST_REGISTRY_URL" \
    ANTNEST_TEST_SLOW_PROXY_PORT="$proxy_port" \
    node tests/integration/skill-registry/slow-artifact-proxy.mjs >"$temp_dir/proxy.log" 2>&1 &
  proxy_pid=$!
  registry_for_controller="$ANTNEST_TEST_SLOW_PROXY_URL"
fi
start_controller() {
  ANTNEST_RUNTIME_CONTROLLER_LISTEN="127.0.0.1:$controller_port" \
    ANTNEST_RUNTIME_CONTROLLER_DATABASE_URL="postgres://postgres:antnest_test@127.0.0.1:$pg_port/postgres?sslmode=disable" \
    ANTNEST_RUNTIME_MANAGEMENT_NETWORK="$network_name" \
    ANTNEST_SKILL_REGISTRY_URL="$registry_for_controller" \
    ANTNEST_RUNTIME_SKILL_PREPARER_IMAGE=postgres:17.11-bookworm \
    "$temp_dir/runtime-controller" >"$temp_dir/controller-$1.log" 2>&1 &
  controller_pid=$!
}
start_controller initial

for _ in $(seq 1 60); do
  if curl -fsS "$ANTNEST_TEST_REGISTRY_URL/status" >/dev/null 2>&1 &&
     curl -fsS "$ANTNEST_TEST_RUNTIME_CONTROLLER_URL/status" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$registry_pid" 2>/dev/null || ! kill -0 "$controller_pid" 2>/dev/null; then
    cat "$temp_dir/registry.log" "$temp_dir/controller-initial.log" >&2
    exit 1
  fi
  sleep 1
done
curl -fsS "$ANTNEST_TEST_REGISTRY_URL/status" >/dev/null
curl -fsS "$ANTNEST_TEST_RUNTIME_CONTROLLER_URL/status" >/dev/null
if [[ "${ANTNEST_TEST_SLOW_SKILL_PREPARATION:-false}" == true ]]; then
  curl -fsS "$ANTNEST_TEST_SLOW_PROXY_URL/__test/status" >/dev/null
fi
if [[ "${ANTNEST_TEST_RESTART_SKILL_PREPARATION:-false}" == true ]]; then
  export ANTNEST_TEST_RESTART_REQUEST_FILE="$temp_dir/restart.request"
  export ANTNEST_TEST_RESTART_DONE_FILE="$temp_dir/restart.done"
  node tests/integration/skill-registry/registry-rc-prepare.mjs &
  test_pid=$!
  for _ in $(seq 1 600); do
    [[ -f "$ANTNEST_TEST_RESTART_REQUEST_FILE" ]] && break
    if ! kill -0 "$test_pid" 2>/dev/null; then break; fi
    sleep 0.25
  done
  if [[ ! -f "$ANTNEST_TEST_RESTART_REQUEST_FILE" ]]; then
    wait "$test_pid"
    echo 'Skill preparation did not reach the restart checkpoint' >&2
    exit 1
  fi
  kill "$controller_pid"
  wait "$controller_pid" 2>/dev/null || true
  start_controller restarted
  for _ in $(seq 1 60); do
    if curl -fsS "$ANTNEST_TEST_RUNTIME_CONTROLLER_URL/status" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$controller_pid" 2>/dev/null; then
      cat "$temp_dir/controller-restarted.log" >&2
      exit 1
    fi
    sleep 1
  done
  curl -fsS "$ANTNEST_TEST_RUNTIME_CONTROLLER_URL/status" >/dev/null
  touch "$ANTNEST_TEST_RESTART_DONE_FILE"
  wait "$test_pid"
  test_pid=''
else
  node tests/integration/skill-registry/registry-rc-prepare.mjs
fi
