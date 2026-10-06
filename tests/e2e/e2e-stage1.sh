#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repository_root"
. "$repository_root/tests/support/public-development-secrets.sh"
export COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}:tests/support/compose.public-development-secrets.yaml"
node tests/support/storage.mjs "$repository_root/artifacts/verification/stage1"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-antnest-stage1-e2e-$$}"
export ANTNEST_POSTGRES_HOST_PORT="${ANTNEST_POSTGRES_HOST_PORT:-$((30000 + ($$ % 10000)))}"
export ANTNEST_RUNTIME_MANAGEMENT_NETWORK="${ANTNEST_RUNTIME_MANAGEMENT_NETWORK:-${COMPOSE_PROJECT_NAME}-runtime-management}"
network_octet=$((1 + ($$ % 200)))
export ANTNEST_RUNTIME_MANAGEMENT_SUBNET="${ANTNEST_RUNTIME_MANAGEMENT_SUBNET:-10.253.${network_octet}.0/24}"
export ANTNEST_EGRESS_IPV4="${ANTNEST_EGRESS_IPV4:-10.253.${network_octet}.3}"
export ANTNEST_EGRESS_CONTROL_SUBNET="${ANTNEST_EGRESS_CONTROL_SUBNET:-10.252.${network_octet}.0/24}"
export ANTNEST_EGRESS_CONTROL_IPV4="${ANTNEST_EGRESS_CONTROL_IPV4:-10.252.${network_octet}.3}"

control_url="http://${ANTNEST_EGRESS_CONTROL_IPV4}:8081"
runtime_name="${COMPOSE_PROJECT_NAME}-runtime"
mcp_url="http://antnest-runtime-agent-stage1-e2e:8093/mcp"
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/antnest-stage1-e2e.XXXXXX")
workspace="$temporary_root/workspace"
runtime_execution_id=""
auth_volume="${COMPOSE_PROJECT_NAME}-native-receiver"
runtime_image="${ANTNEST_E2E_RUNTIME_IMAGE:?use make e2e-stage1 to build an authenticated disposable fixture}"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then
    docker compose ps >&2 || true
    docker compose logs --no-color --tail=200 runtime-egress >&2 || true
    if docker inspect "$runtime_name" >/dev/null 2>&1; then
      docker logs --tail=200 "$runtime_name" >&2 || true
    fi
  fi
  docker rm -f "$runtime_name" >/dev/null 2>&1 || true
  docker volume rm "$auth_volume" >/dev/null 2>&1 || true
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  if [ -d "$workspace" ]; then
    # The Agent writes the workspace as its own uid. On a native Linux daemon
    # the invoking user cannot delete those directories, so root clears them.
    docker run --rm --pull never --network none --user 0:0 \
      --mount "type=bind,src=$workspace,dst=/workspace" \
      --entrypoint find "$runtime_image" /workspace -mindepth 1 -delete \
      >/dev/null 2>&1 || true
  fi
  rm -rf -- "${temporary_root:?}"
  exit "$status"
}
trap cleanup EXIT INT TERM

control_request() {
  printf 'Antnest-Service-Authorization: Bearer %s\n' "$(cat "${ANTNEST_SERVICE_AUTH_DIRECTORY:?}/agent-controller/tokens/runtime-egress")" \
    | docker compose exec -T runtime-egress curl --header @- --fail-with-body -sS "$@"
}

network_version() {
  node -e '
    const value = JSON.parse(process.argv[1])[process.argv[2]];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("Missing positive Egress resource version");
    }
    process.stdout.write(String(value));
  ' "$1" "$2"
}

mcp_request() {
  request=$1
  method=$2
  name=${3:-}
  response_file=/tmp/antnest-stage1-mcp-response
  status=$(cat "$temporary_root/runtime-auth/mcp.headers" | docker compose exec -T runtime-egress curl --header @- -sS \
    -o "$response_file" \
    -w '%{http_code}' \
    -X POST \
    -H 'accept: application/json, text/event-stream' \
    -H 'content-type: application/json' \
    -H 'mcp-protocol-version: 2026-07-28' \
    -H "X-Antnest-Expected-Execution-ID: $runtime_execution_id" \
    -H "mcp-method: $method" \
    -H "mcp-name: $name" \
    --data-binary "$request" \
    "$mcp_url")
  response=$(docker compose exec -T runtime-egress cat "$response_file")
  docker compose exec -T runtime-egress rm -f "$response_file"
  case "$status" in
    2??) printf '%s' "$response" ;;
    *)
      printf 'MCP request failed with HTTP %s: %s\n' "$status" "$response" >&2
      return 1
      ;;
  esac
}

mkdir "$workspace"
chmod 0777 "$workspace"

docker compose up -d --wait postgres runtime-egress

docker compose exec -T runtime-egress curl --fail-with-body -sS http://127.0.0.1:8082/status | grep -q '"status":"ready"'
network=$(control_request -X PUT \
  "$control_url/internal/agent-networks/agent-stage1-e2e")
printf '%s' "$network" | grep -q '"tunnel_ipv4":"100.64.0.2"'
printf '%s' "$network" | grep -q '"attachment_state":"closed"'
network_resource_version=$(network_version "$network" network_resource_version)
attachment_resource_version=$(network_version "$network" attachment_resource_version)
control_request -X PUT \
  -H 'content-type: application/json' \
  -d '{"spec":{"schema_version":1,"action":"allow_all"}}' \
  "$control_url/internal/policies/stage1-allow/revisions/1" \
  >/dev/null
control_request -X PUT \
  -H 'content-type: application/json' \
  -d '{"policy_id":"stage1-allow","revision":1,"expected_resource_version":1}' \
  "$control_url/internal/agent-policy-assignments/agent-stage1-e2e" \
  >/dev/null

authentication=$(node tests/support/runtime-receiver-fixture.mjs "$temporary_root/runtime-auth")
docker volume create --label "io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME" "$auth_volume" >/dev/null
docker run --rm -i --network none --entrypoint sh \
  --label "io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME" \
  --mount "type=volume,src=$auth_volume,dst=/run/antnest-auth" \
  "$runtime_image" -c 'chmod 700 /run/antnest-auth; umask 077; cat > /run/antnest-auth/callers.json; chmod 600 /run/antnest-auth/callers.json' \
  < "$temporary_root/runtime-auth/callers.json"
runtime_spec="{\"agent_id\":\"agent-stage1-e2e\",\"generation\":1,\"listen\":{\"host\":\"0.0.0.0\",\"port\":8093},\"network\":{\"packet_contract_revision\":1,\"egress_endpoint\":{\"ipv4\":\"${ANTNEST_EGRESS_IPV4}\",\"port\":8092},\"tunnel_ipv4\":\"100.64.0.2\",\"resolver_ipv4\":\"100.64.0.1\"},\"filesystem\":{\"workspace\":\"/workspace\",\"system_skills\":\"/skills\"},\"authentication\":${authentication}}"

docker run -d \
  --name "$runtime_name" \
  --label "io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME" \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add DAC_OVERRIDE \
  --cap-add KILL \
  --cap-add NET_ADMIN \
  --cap-add SETGID \
  --cap-add SETPCAP \
  --cap-add SETUID \
  --device /dev/net/tun \
  --sysctl net.ipv4.conf.all.rp_filter=1 \
  --sysctl net.ipv4.conf.default.rp_filter=1 \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --dns 100.64.0.1 \
  --dns-option use-vc \
  --mount "type=bind,src=$workspace,dst=/workspace" \
  --mount "type=volume,src=$auth_volume,dst=/run/antnest-auth,readonly" \
  --network "$ANTNEST_RUNTIME_MANAGEMENT_NETWORK" \
  --network-alias antnest-runtime-agent-stage1-e2e \
  --env "ANTNEST_RUNTIME_SPEC=$runtime_spec" \
  --env ANTNEST_SERVICE_AUTH_MODE=token \
  --env ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT=true \
  --env ANTNEST_SERVICE_AUTH_CALLERS_FILE=/run/antnest-auth/callers.json \
  --env OTEL_SDK_DISABLED=true \
  "$runtime_image" \
  >/dev/null

wait_runtime_ready() {
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    runtime_status=$(cat "$temporary_root/runtime-auth/status.headers" | docker exec -i "$runtime_name" curl --header @- -fsS http://127.0.0.1:8093/status 2>/dev/null || true)
    runtime_execution_id=$(printf '%s' "$runtime_status" | sed -n 's/.*"execution_id":"\([^"]*\)".*/\1/p')
    if printf '%s' "$runtime_status" | grep -q '"generation":1' &&
      printf '%s' "$runtime_status" | grep -q '"status":"ready"' &&
      [ -n "$runtime_execution_id" ]; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  docker logs "$runtime_name"
  echo "Runtime did not become ready" >&2
  exit 1
}
wait_runtime_ready

echo "Checking the production MCP and Executor boundary"
mcp_tools=$(mcp_request '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}' 'tools/list')
for tool_name in bash edit read write; do
  printf '%s' "$mcp_tools" | grep -q "\"name\":\"$tool_name\""
done
mcp_request '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}},"name":"write","arguments":{"path":"stage1-mcp.txt","content":"before"}}}' 'tools/call' 'write' \
  >/dev/null
mcp_request '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}},"name":"edit","arguments":{"path":"stage1-mcp.txt","old_string":"before","new_string":"after"}}}' 'tools/call' 'edit' \
  >/dev/null
mcp_read=$(mcp_request '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}},"name":"read","arguments":{"path":"stage1-mcp.txt"}}}' 'tools/call' 'read')
printf '%s' "$mcp_read" | grep -q '"content":"after"'
mcp_bash=$(mcp_request '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}},"name":"bash","arguments":{"command":"printf '\''%s:%s:'\'' \"$(id -u)\" \"$(id -g)\"; cat stage1-mcp.txt","working_dir":".","env":[],"timeout_ms":1000}}}' 'tools/call' 'bash')
printf '%s' "$mcp_bash" | grep -q '"stdout":"1000:1000:after"'

echo "Checking crash-only Runtime restart in the retained container network"
first_execution_id=$runtime_execution_id
docker restart "$runtime_name" >/dev/null
wait_runtime_ready
if [ "$runtime_execution_id" = "$first_execution_id" ]; then
  echo "Runtime restart reused its execution identity" >&2
  exit 1
fi
mcp_request '{"jsonrpc":"2.0","id":6,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}' 'tools/list' \
  | grep -q '"name":"bash"'

echo "Checking closed attachment with an allow_all desired policy"
if docker exec --user 1000 "$runtime_name" \
  curl -kfsS --connect-timeout 2 --max-time 2 https://1.1.1.1 \
  >/dev/null 2>&1; then
  echo "A closed attachment allowed outbound traffic" >&2
  exit 1
fi

runtime_endpoint=$(docker inspect \
  --format "{{(index .NetworkSettings.Networks \"$ANTNEST_RUNTIME_MANAGEMENT_NETWORK\").IPAddress}}" \
  "$runtime_name")
test -n "$runtime_endpoint"
opened=$(control_request -X PUT \
  -H 'content-type: application/json' \
  -d "{\"state\":\"open\",\"expected_resource_version\":${attachment_resource_version},\"runtime_endpoint\":\"${runtime_endpoint}\"}" \
  "$control_url/internal/agent-network-attachments/agent-stage1-e2e")
printf '%s' "$opened" | grep -q '"attachment_state":"open"'
attachment_resource_version=$(network_version "$opened" attachment_resource_version)
test "$(network_version "$opened" network_resource_version)" = "$network_resource_version"

echo "Checking open attachment allow_all data path"
docker exec --user 1000 "$runtime_name" \
  curl -kfsS --connect-timeout 5 --max-time 10 https://1.1.1.1 \
  >/dev/null
docker exec --user 1000 "$runtime_name" \
  curl -fsS --connect-timeout 5 --max-time 10 https://example.com \
  | grep -q 'Example Domain'

echo "Checking control-plane isolation with an open allow_all attachment"
for control_address in "$ANTNEST_EGRESS_IPV4" "$ANTNEST_EGRESS_CONTROL_IPV4"; do
  if docker exec --user 1000 "$runtime_name" \
    curl -sS --connect-timeout 1 --max-time 2 \
    "http://${control_address}:8081/status" \
    >/dev/null 2>&1; then
    echo "Runtime reached Egress control address ${control_address}" >&2
    exit 1
  fi
  if docker exec "$runtime_name" \
    curl -sS --connect-timeout 1 --max-time 2 \
    "http://${control_address}:8081/status" \
    >/dev/null 2>&1; then
    echo "Runtime root route reached Egress control address ${control_address}" >&2
    exit 1
  fi
done

control_request -X PUT \
  -H 'content-type: application/json' \
  -d '{"policy_id":"builtin/deny-all","revision":1,"expected_resource_version":2}' \
  "$control_url/internal/agent-policy-assignments/agent-stage1-e2e" \
  >/dev/null
echo "Checking deny_all policy update"
if docker exec --user 1000 "$runtime_name" \
  curl -kfsS --connect-timeout 2 --max-time 2 https://1.1.1.1 \
  >/dev/null 2>&1; then
  echo "deny_all allowed a direct TCP connection" >&2
  exit 1
fi

control_request -X PUT \
  -H 'content-type: application/json' \
  -d '{"policy_id":"stage1-allow","revision":1,"expected_resource_version":3}' \
  "$control_url/internal/agent-policy-assignments/agent-stage1-e2e" \
  >/dev/null
echo "Checking allow_all policy restoration"
docker exec --user 1000 "$runtime_name" \
  curl -kfsS --connect-timeout 5 --max-time 10 https://1.1.1.1 \
  >/dev/null
docker exec --user 1000 "$runtime_name" \
  curl -fsS --connect-timeout 5 --max-time 10 https://example.com \
  | grep -q 'Example Domain'

docker compose restart runtime-egress
docker compose up -d --wait runtime-egress
echo "Checking persisted state after Egress restart"
control_request "$control_url/internal/agent-policy-assignments/agent-stage1-e2e" \
  | grep -q '"resource_version":4'
docker exec --user 1000 "$runtime_name" \
  curl -kfsS --connect-timeout 5 --max-time 10 https://1.1.1.1 \
  >/dev/null
docker exec --user 1000 "$runtime_name" \
  curl -fsS --connect-timeout 5 --max-time 10 https://example.com \
  | grep -q 'Example Domain'

echo "Checking attachment closure and independent network release"
closed=$(control_request -X PUT \
  -H 'content-type: application/json' \
  -d "{\"state\":\"closed\",\"expected_resource_version\":${attachment_resource_version}}" \
  "$control_url/internal/agent-network-attachments/agent-stage1-e2e")
printf '%s' "$closed" | grep -q '"attachment_state":"closed"'
test "$(network_version "$closed" network_resource_version)" = "$network_resource_version"
if docker exec --user 1000 "$runtime_name" \
  curl -kfsS --connect-timeout 2 --max-time 2 https://1.1.1.1 \
  >/dev/null 2>&1; then
  echo "Closing an open attachment left outbound traffic available" >&2
  exit 1
fi
docker rm -f "$runtime_name" >/dev/null
control_request -X POST \
  -H 'content-type: application/json' \
  -d "{\"expected_resource_version\":${network_resource_version}}" \
  "$control_url/internal/agent-networks/agent-stage1-e2e/release" \
  | grep -q '"state":"quarantined"'

echo "Stage 1 Runtime/Egress E2E passed"
