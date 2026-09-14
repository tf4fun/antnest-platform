#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository_root"

port_base=$((42000 + ($$ % 8000)))
network_octet=$(node scripts/acp-closeout/network.mjs "$((1 + ($$ % 200)))")
export COMPOSE_PROJECT_NAME="antnest-stage3-e2e-$$"
export ANTNEST_E2E_RUN_ID=$(node -e 'process.stdout.write(crypto.randomUUID())')
export ANTNEST_POSTGRES_HOST_PORT=$port_base
export ANTNEST_EDGE_HOST_PORT=$((port_base + 1))
export ANTNEST_JAEGER_UI_HOST_PORT=$((port_base + 2))
export ANTNEST_OIDC_TEST_PORT=$((port_base + 3))
export ANTNEST_EDGE_PUBLIC_BASE_URL="http://127.0.0.1:${ANTNEST_EDGE_HOST_PORT}"
export ANTNEST_RUNTIME_CONTROLLER_SCOPE="$COMPOSE_PROJECT_NAME"
export ANTNEST_RUNTIME_MANAGEMENT_NETWORK="${COMPOSE_PROJECT_NAME}-runtime-management"
export ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME="${COMPOSE_PROJECT_NAME}-system-skills"
export ANTNEST_RUNTIME_MANAGEMENT_SUBNET="10.243.${network_octet}.0/24"
export ANTNEST_EGRESS_IPV4="10.243.${network_octet}.3"
export ANTNEST_JAEGER_RUNTIME_IPV4="10.243.${network_octet}.4"
export ANTNEST_EGRESS_CONTROL_SUBNET="10.242.${network_octet}.0/24"
export ANTNEST_EGRESS_CONTROL_IPV4="10.242.${network_octet}.3"
export OTEL_SDK_DISABLED=false
export OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_TRACES_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=none
export OTEL_LOGS_EXPORTER=none
export ANTNEST_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT="http://${ANTNEST_JAEGER_RUNTIME_IPV4}:4318"
export ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=stage3
export ANTNEST_BOOTSTRAP_ORGANIZATION_NAME="Stage 3"
export ANTNEST_BOOTSTRAP_ADMIN_EMAIL=stage3-admin@example.com
export ANTNEST_BOOTSTRAP_ADMIN_PASSWORD=stage3-admin-password
keep_stack=${ANTNEST_E2E_KEEP_STACK:-false}
identity_access=${ANTNEST_E2E_IDENTITY_ACCESS:-false}
acp_session=${ANTNEST_E2E_ACP_SESSION:-false}
agent_access=${ANTNEST_E2E_AGENT_ACCESS:-false}
tool_progress=${ANTNEST_E2E_TOOL_PROGRESS:-false}
file_observations=${ANTNEST_E2E_FILE_OBSERVATIONS:-false}
structured_plan=${ANTNEST_E2E_STRUCTURED_PLAN:-false}
slash_commands=${ANTNEST_E2E_SLASH_COMMANDS:-false}
multimodal=${ANTNEST_E2E_MULTIMODAL:-false}
session_cost=${ANTNEST_E2E_SESSION_COST:-false}
rpc_response_loss=${ANTNEST_E2E_RPC_RESPONSE_LOSS:-false}
case "$rpc_response_loss" in
  true|false) ;;
  *) echo 'ANTNEST_E2E_RPC_RESPONSE_LOSS must be true or false' >&2; exit 1 ;;
esac
if [ "$rpc_response_loss" = true ]; then
  for incompatible in "$session_cost" "$multimodal" "$slash_commands" "$structured_plan" "$file_observations" "$tool_progress" "$keep_stack" "$agent_access" "$identity_access" "$acp_session" "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" "${ANTNEST_E2E_MANAGED_MCP:-false}"; do
    [ "$incompatible" = false ] || { echo 'RPC response loss requires a separate disposable profile' >&2; exit 1; }
  done
fi
case "$session_cost" in
  true|false) ;;
  *) echo "ANTNEST_E2E_SESSION_COST must be true or false" >&2; exit 1 ;;
esac
if [ "$session_cost" = true ] && { [ "$multimodal" = true ] || [ "$slash_commands" = true ] || [ "$structured_plan" = true ] || [ "$file_observations" = true ] || [ "$tool_progress" = true ] || [ "$keep_stack" = true ] || [ "$agent_access" = true ] || [ "$identity_access" = true ] || [ "$acp_session" = true ] || [ "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" = true ]; }; then
  echo "Session cost requires a separate disposable profile" >&2
  exit 1
fi
case "$multimodal" in
  true|false) ;;
  *) echo "ANTNEST_E2E_MULTIMODAL must be true or false" >&2; exit 1 ;;
esac
if [ "$multimodal" = true ] && { [ "$slash_commands" = true ] || [ "$structured_plan" = true ] || [ "$file_observations" = true ] || [ "$tool_progress" = true ] || [ "$keep_stack" = true ] || [ "$agent_access" = true ] || [ "$identity_access" = true ] || [ "$acp_session" = true ] || [ "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" = true ]; }; then
  echo "Multimodal input requires a separate disposable profile" >&2
  exit 1
fi
case "$slash_commands" in
  true|false) ;;
  *) echo "ANTNEST_E2E_SLASH_COMMANDS must be true or false" >&2; exit 1 ;;
esac
if [ "$slash_commands" = true ] && { [ "$structured_plan" = true ] || [ "$file_observations" = true ] || [ "$tool_progress" = true ] || [ "$keep_stack" = true ] || [ "$agent_access" = true ] || [ "$identity_access" = true ] || [ "$acp_session" = true ] || [ "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" = true ]; }; then
  echo "Slash commands require a separate disposable profile" >&2
  exit 1
fi
case "$structured_plan" in
  true|false) ;;
  *) echo "ANTNEST_E2E_STRUCTURED_PLAN must be true or false" >&2; exit 1 ;;
esac
if [ "$structured_plan" = true ] && { [ "$file_observations" = true ] || [ "$tool_progress" = true ] || [ "$keep_stack" = true ] || [ "$agent_access" = true ] || [ "$identity_access" = true ] || [ "$acp_session" = true ] || [ "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" = true ]; }; then
  echo "Structured plan requires a separate disposable profile" >&2
  exit 1
fi
case "$file_observations" in
  true|false) ;;
  *) echo "ANTNEST_E2E_FILE_OBSERVATIONS must be true or false" >&2; exit 1 ;;
esac
if [ "$file_observations" = true ] && { [ "$tool_progress" = true ] || [ "$keep_stack" = true ] || [ "$agent_access" = true ] || [ "$identity_access" = true ] || [ "$acp_session" = true ] || [ "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" = true ]; }; then
  echo "File observations require a separate disposable profile" >&2
  exit 1
fi
tool_profile=""
[ "$tool_progress" != true ] || tool_profile=tool-progress
[ "$file_observations" != true ] || tool_profile=file-observations
[ "$structured_plan" != true ] || tool_profile=structured-plan
[ "$slash_commands" != true ] || tool_profile=slash-commands
[ "$multimodal" != true ] || tool_profile=multimodal
[ "$session_cost" != true ] || tool_profile=session-cost
[ "$rpc_response_loss" != true ] || tool_profile=rpc-response-loss
case "$tool_progress" in
  true|false) ;;
  *) echo "ANTNEST_E2E_TOOL_PROGRESS must be true or false" >&2; exit 1 ;;
esac
if [ "$tool_progress" = true ] && { [ "$keep_stack" = true ] || [ "$agent_access" = true ] || [ "$identity_access" = true ] || [ "$acp_session" = true ] || [ "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" = true ]; }; then
  echo "Tool progress requires a separate disposable profile" >&2
  exit 1
fi
case "$agent_access" in
  true|false) ;;
  *) echo "ANTNEST_E2E_AGENT_ACCESS must be true or false" >&2; exit 1 ;;
esac
if [ "$agent_access" = true ] && { [ "$keep_stack" = true ] || [ "$identity_access" = true ] || [ "$acp_session" = true ] || [ "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" = true ]; }; then
  echo "Agent access requires a separate disposable profile" >&2
  exit 1
fi
case "$acp_session" in
  true|false) ;;
  *) echo "ANTNEST_E2E_ACP_SESSION must be true or false" >&2; exit 1 ;;
esac
if [ "$acp_session" = true ] && { [ "$keep_stack" = true ] || [ "$identity_access" = true ] || [ "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" = true ]; }; then
  echo "ACP session faults require a separate disposable profile" >&2
  exit 1
fi
case "$identity_access" in
  true|false) ;;
  *) echo "ANTNEST_E2E_IDENTITY_ACCESS must be true or false" >&2; exit 1 ;;
esac
if [ "$identity_access" = true ] && { [ "$keep_stack" = true ] || [ "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" = true ]; }; then
  echo "Identity access requires a disposable project and a separate profile" >&2
  exit 1
fi
export ANTNEST_IDENTITY_ACCESS_TOKEN_TTL=12h
if [ -n "$tool_profile" ]; then
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
  docker() { node "$repository_root/scripts/acp-closeout/docker.mjs" "$@"; }
fi
case "$keep_stack" in
  true|false) ;;
  *) echo "ANTNEST_E2E_KEEP_STACK must be true or false" >&2; exit 1 ;;
esac

runtime_image=$(docker image inspect --format '{{.Id}}' antnest/antnest-runtime:local)
if ! printf '%s' "$runtime_image" | grep -Eq '^sha256:[a-f0-9]{64}$'; then
  printf 'Runtime image is not immutable: %s\n' "$runtime_image" >&2
  exit 1
fi
export ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF=$runtime_image

gateway_url="http://127.0.0.1:${ANTNEST_EDGE_HOST_PORT}"
jaeger_url="http://127.0.0.1:${ANTNEST_JAEGER_UI_HOST_PORT}"
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/antnest-stage3-e2e.XXXXXX")
cookie_jar="$temporary_root/cookies.txt"
workspace_cookie_jar="$temporary_root/workspace-cookies.txt"
agent_id=""

compose() {
  if [ "$rpc_response_loss" = true ]; then
    if [ "$1" = up ]; then
      docker --lifecycle compose -f compose.yaml -f compose.stage3.yaml -f scripts/acp-closeout/rpc-compose.yaml --profile stage3 --profile observability "$@"
    else
      docker compose -f compose.yaml -f compose.stage3.yaml -f scripts/acp-closeout/rpc-compose.yaml --profile stage3 --profile observability "$@"
    fi
    return
  fi
  if [ -n "$tool_profile" ]; then
    if [ "$1" = up ]; then
      docker --lifecycle compose -f compose.yaml -f compose.stage3.yaml --profile stage3 --profile observability "$@"
    else
      docker compose -f compose.yaml -f compose.stage3.yaml --profile stage3 --profile observability "$@"
    fi
    return
  fi
  if [ "$acp_session" = true ]; then
    docker compose -f compose.yaml -f compose.stage3.yaml -f scripts/identity-closeout/oidc-compose.yaml \
      -f scripts/identity-closeout/acp-session-compose.yaml --profile stage3 --profile stage3-e2e --profile observability "$@"
    return
  fi
  if [ "$identity_access" = true ]; then
    docker compose -f compose.yaml -f compose.stage3.yaml -f scripts/identity-closeout/oidc-compose.yaml \
      -f scripts/identity-closeout/access-compose.yaml --profile stage3 --profile stage3-e2e --profile observability "$@"
    return
  fi
  if [ "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" = true ]; then
    docker compose -f compose.yaml -f compose.stage3.yaml -f scripts/identity-closeout/oidc-compose.yaml -f scripts/acp-closeout/compose.yaml \
      --profile stage3 --profile stage3-e2e --profile observability "$@"
    return
  fi
  docker compose -f compose.yaml -f compose.stage3.yaml -f scripts/identity-closeout/oidc-compose.yaml --profile stage3 --profile stage3-e2e --profile observability "$@"
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$tool_profile" ]; then
    export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+120000))')
  fi
  if [ "$status" -ne 0 ]; then
    compose ps >&2 || true
    compose logs --no-color --tail=200 edge-gateway admin-console agent-ui agent-acp-service \
      identity-service agent-controller runtime-controller runtime-egress stage3-model jaeger \
      > "$temporary_root/failure-logs.txt" 2>/dev/null || true
    node scripts/identity-closeout/check-oidc-logs.mjs --summary "$temporary_root/failure-logs.txt" >&2 || true
    printf 'Raw service and runtime logs omitted: they may contain credentials.\n' >&2
  fi
  if [ "$status" -eq 0 ] && [ "$keep_stack" = true ]; then
    if [ -f "$temporary_root/lifecycle-trace-evidence.json" ]; then
      cat "$temporary_root/lifecycle-trace-evidence.json" || return 1
    fi
    rm -rf -- "${temporary_root:?}"
    return
  fi
  # Stop asynchronous creators before enumerating their Docker resources.
  compose stop agent-controller runtime-controller >/dev/null 2>&1 || status=1
  if [ -n "$tool_profile" ]; then
    docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" |
      while IFS= read -r owned_container; do
        [ -z "$owned_container" ] || docker rm -f "$owned_container" >/dev/null 2>&1 || true
      done
  fi
  docker ps -aq --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME" 2>/dev/null |
    while IFS= read -r runtime_container; do
      [ -z "$runtime_container" ] || docker rm -f "$runtime_container" >/dev/null 2>&1 || true
    done
  docker volume ls -q --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME" 2>/dev/null |
    while IFS= read -r runtime_volume; do
      [ -z "$runtime_volume" ] || docker volume rm -f "$runtime_volume" >/dev/null 2>&1 || true
    done
  compose down --volumes --remove-orphans >/dev/null 2>&1 || status=1
  for scope_label in \
    "io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME" \
    "com.docker.compose.project=$COMPOSE_PROJECT_NAME"; do
    containers=$(docker ps -aq --filter "label=$scope_label") || status=1
    volumes=$(docker volume ls -q --filter "label=$scope_label") || status=1
    networks=$(docker network ls -q --filter "label=$scope_label") || status=1
    if [ -n "$containers" ] || [ -n "$volumes" ] || [ -n "$networks" ]; then
      printf 'Test cleanup left resources for %s: containers=%s volumes=%s networks=%s\n' "$scope_label" "$containers" "$volumes" "$networks" >&2
      status=1
    fi
  done
  if [ "$status" -eq 0 ] && [ "${ANTNEST_E2E_MANAGED_MCP:-false}" = true ]; then
    cat "$temporary_root/managed-mcp-evidence.json" || status=1
  fi
  if [ "$status" -eq 0 ] && [ "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" = true ]; then
    cat "$temporary_root/acp-closeout.json" || status=1
  fi
  if [ "$status" -eq 0 ] && [ "$tool_profile" = rpc-response-loss ]; then
    cat "$temporary_root/rpc-response-loss.json" || status=1
  fi
  if [ "$status" -eq 0 ] && [ -f "$temporary_root/lifecycle-trace-evidence.json" ]; then
    cat "$temporary_root/lifecycle-trace-evidence.json" || status=1
  fi
  rm -rf -- "${temporary_root:?}"
  if [ -n "$tool_profile" ] && [ "$status" -eq 0 ]; then
    echo "ACP v1/v2 deployed $tool_profile E2E passed; owned resources removed"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

json_field() {
  node -e '
    const fs = require("node:fs");
    let value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const segment of process.argv[2].split(".")) value = value?.[segment];
    if (value === undefined) {
      console.error(`Missing response field: ${process.argv[2]}`);
      process.exit(2);
    }
    process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
  ' "$1" "$2"
}

assert_field() {
  actual=$(json_field "$1" "$2")
  if [ "$actual" != "$3" ]; then
    printf '%s field %s = %s, want %s\n' "$1" "$2" "$actual" "$3" >&2
    return 1
  fi
}

event_trace_id() {
  node -e '
    const payload = require(process.argv[1]);
    const event = payload.events?.find(
      (item) => item.event_type === process.argv[2] && item.operation_request_id === process.argv[3],
    );
    if (!event?.trace_id) process.exit(2);
    process.stdout.write(event.trace_id);
  ' "$1" "$2" "$3"
}

gateway_request() {
  method=$1
  path=$2
  body_file=$3
  response_file=$4
  expected_status=$5
  headers_file=${6:-/dev/null}
  csrf_header=""
  idempotency_header=""
  if [ "$method" != GET ] && [ "$path" != "/api/session/login" ]; then
    csrf=$(awk '$6 == "antnest_csrf" { value=$7 } END { print value }' "$cookie_jar")
    [ -n "$csrf" ] || { echo "CSRF cookie is missing" >&2; return 1; }
    csrf_header="X-Antnest-CSRF-Token: $csrf"
    body_key=${body_file##*/}
    idempotency_header="Idempotency-Key: stage3-e2e-${method}-${path}-${body_key}"
  fi
  if [ "$body_file" = "-" ]; then
    status=$(curl -sS -D "$headers_file" -o "$response_file" -w '%{http_code}' \
      -X "$method" -b "$cookie_jar" -c "$cookie_jar" \
      -H 'accept: application/json' "$gateway_url$path")
  elif [ -z "$csrf_header" ]; then
    status=$(curl -sS -D "$headers_file" -o "$response_file" -w '%{http_code}' \
      -X "$method" -b "$cookie_jar" -c "$cookie_jar" \
      -H 'accept: application/json' -H 'content-type: application/json' \
      --data-binary "@$body_file" "$gateway_url$path")
  else
    status=$(curl -sS -D "$headers_file" -o "$response_file" -w '%{http_code}' \
      -X "$method" -b "$cookie_jar" -c "$cookie_jar" \
      -H 'accept: application/json' -H 'content-type: application/json' \
      -H "$csrf_header" -H "$idempotency_header" \
      --data-binary "@$body_file" "$gateway_url$path")
  fi
  if [ "$status" != "$expected_status" ]; then
    printf '%s %s returned HTTP %s, want %s: ' "$method" "$path" "$status" "$expected_status" >&2
    cat "$response_file" >&2
    printf '\n' >&2
    return 1
  fi
}

wait_operation() {
  request_id=$1
  response_file=$2
  attempt=0
  while [ "$attempt" -lt 120 ]; do
    gateway_request GET "/api/admin/operations/${request_id}" - "$response_file" 200
    state=$(json_field "$response_file" state)
    case "$state" in
      completed) return 0 ;;
      failed)
        printf 'Lifecycle operation %s failed: ' "$request_id" >&2
        cat "$response_file" >&2
        printf '\n' >&2
        return 1
        ;;
      running) ;;
      *)
        printf 'Lifecycle operation %s returned unknown state %s\n' "$request_id" "$state" >&2
        return 1
        ;;
    esac
    attempt=$((attempt + 1))
    sleep 1
  done
  printf 'Lifecycle operation %s did not settle\n' "$request_id" >&2
  return 1
}

wait_agent_ready() {
  ready_agent_id=$1
  ready_response_file=$2
  ready_attempt=0
  while [ "$ready_attempt" -lt 120 ]; do
    gateway_request GET "/api/admin/agents/${ready_agent_id}" - "$ready_response_file" 200
    if node --input-type=module -e '
      import { readFileSync } from "node:fs";
      import { agentReady } from "./scripts/verification/agent-state.mjs";
      process.exitCode = agentReady(JSON.parse(readFileSync(process.argv[1], "utf8"))) ? 0 : 1;
    ' "$ready_response_file"; then return 0; fi
    ready_attempt=$((ready_attempt + 1))
    sleep 1
  done
  printf 'Agent %s did not become executable\n' "$ready_agent_id" >&2
  return 1
}

if [ -n "$tool_profile" ]; then
  compose up -d --wait
  if [ "$rpc_response_loss" = true ]; then
    ANTNEST_E2E_DISPOSABLE=true sh scripts/e2e-rpc-response-loss.sh >"$temporary_root/rpc-response-loss.json"
    assert_field "$temporary_root/rpc-response-loss.json" status passed
  else
    ANTNEST_E2E_DISPOSABLE=true sh "scripts/e2e-${tool_profile}.sh"
  fi
  exit 0
fi

mkdir "$temporary_root/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=oidc-fixture \
  -addext 'subjectAltName=DNS:oidc-fixture' \
  -keyout "$temporary_root/certs/tls.key" -out "$temporary_root/certs/tls.crt" >/dev/null 2>&1
compose create oidc-fixture
docker run --rm --network none --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --mount "type=bind,source=$temporary_root/certs,target=/input,readonly" \
  --mount "type=volume,source=${COMPOSE_PROJECT_NAME}-oidc-certs,target=/certs" \
  debian:bookworm-slim cp /input/tls.key /input/tls.crt /certs/
compose up -d --wait

if [ "$agent_access" = true ]; then
  ANTNEST_E2E_DISPOSABLE=true sh scripts/e2e-agent-access.sh
  echo "Cross-organization Agent and ACP access E2E passed"
  exit 0
fi

if [ "$acp_session" = true ]; then
  ANTNEST_E2E_DISPOSABLE=true sh scripts/e2e-acp-session.sh
  echo "ACP browser session expiry, outage recovery and admitted Run E2E passed"
  exit 0
fi

if [ "$identity_access" = true ]; then
  development_network=$(docker network ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --filter label=com.docker.compose.network=development)
  [ -n "$development_network" ] || { echo "Test development network missing" >&2; exit 1; }
  docker run --rm --network "$development_network" \
    --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --mount "type=bind,source=$repository_root/scripts/identity-closeout,target=/fixture,readonly" \
    node:24-bookworm-slim node /fixture/access-seed.mjs > "$temporary_root/access-seed.json"
  node scripts/identity-closeout/access-client.mjs "$gateway_url" "$jaeger_url" "$temporary_root/access-seed.json"
  node scripts/identity-closeout/expiry-client.mjs "$gateway_url" "$jaeger_url" prepare "$temporary_root/expiry.json"
  compose stop identity-service
  node scripts/identity-closeout/expiry-client.mjs "$gateway_url" "$jaeger_url" unavailable "$temporary_root/expiry.json"
  export ANTNEST_IDENTITY_ACCESS_TOKEN_TTL=5s
  compose up -d --wait --no-deps identity-service
  node scripts/identity-closeout/expiry-client.mjs "$gateway_url" "$jaeger_url" expiry "$temporary_root/expiry.json"
  echo "Gateway identity access, isolation, outage and expiry E2E passed"
  exit 0
fi

printf '{"organization_slug":"stage3"}' >"$temporary_root/login-methods-request.json"
login_methods_status=$(curl -sS -D "$temporary_root/login-methods-headers.txt" \
  -o "$temporary_root/login-methods.json" -w '%{http_code}' \
  -H 'accept: application/json' -H 'content-type: application/json' \
  --data-binary "@$temporary_root/login-methods-request.json" \
  "$gateway_url/api/session/login-methods")
if [ "$login_methods_status" != 200 ] ||
  ! grep -iq '^cache-control: no-store' "$temporary_root/login-methods-headers.txt"; then
  echo "Public login-method discovery is unavailable or cacheable" >&2
  exit 1
fi
assert_field "$temporary_root/login-methods.json" methods '[]'

cat >"$temporary_root/login.json" <<'EOF'
{"organization_slug":"stage3","email":"stage3-admin@example.com","password":"stage3-admin-password"}
EOF
gateway_request POST /api/session/login "$temporary_root/login.json" "$temporary_root/login-response.json" 200
organization_id=$(json_field "$temporary_root/login-response.json" principal.organization_id)
owner_user_id=$(json_field "$temporary_root/login-response.json" principal.user_id)

gateway_request GET /api/admin/overview - "$temporary_root/empty-overview.json" 200
node -e '
  const payload = require(process.argv[1]);
  const required = ["directory", "model_profiles", "templates", "agents"];
  if (required.some((name) => payload[name]?.status !== "available")) process.exit(1);
  if (payload.directory.data.users.length !== 1) process.exit(1);
  if (payload.model_profiles.data.items.length !== 0) process.exit(1);
  if (payload.templates.data.items.length !== 0) process.exit(1);
  if (payload.agents.data.items.length !== 0) process.exit(1);
' "$temporary_root/empty-overview.json"

gateway_request GET /api/admin/template-defaults - "$temporary_root/template-defaults.json" 200
assert_field "$temporary_root/template-defaults.json" runtime_image_ref "$runtime_image"

gateway_request GET /api/admin/directory - "$temporary_root/directory.json" 200
assert_field "$temporary_root/directory.json" users.0.user.id "$owner_user_id"

cat >"$temporary_root/password-rejected.json" <<'EOF'
{"current_password":"incorrect-admin-password","new_password":"stage3-admin-password-updated"}
EOF
gateway_request POST /api/admin/account/password "$temporary_root/password-rejected.json" \
  "$temporary_root/password-rejected-response.json" 401
assert_field "$temporary_root/password-rejected-response.json" code invalid_current_password
gateway_request GET /api/admin/directory - "$temporary_root/directory-after-password-rejection.json" 200

cat >"$temporary_root/password-change.json" <<'EOF'
{"current_password":"stage3-admin-password","new_password":"stage3-admin-password-updated"}
EOF
gateway_request POST /api/admin/account/password "$temporary_root/password-change.json" \
  "$temporary_root/password-change-response.json" 200
assert_field "$temporary_root/password-change-response.json" status changed
cat >"$temporary_root/password-login.json" <<'EOF'
{"organization_slug":"stage3","email":"stage3-admin@example.com","password":"stage3-admin-password-updated"}
EOF
password_login_status=$(curl -sS -o "$temporary_root/password-login-response.json" -w '%{http_code}' \
  -H 'accept: application/json' -H 'content-type: application/json' \
  --data-binary "@$temporary_root/password-login.json" "$gateway_url/api/session/login")
if [ "$password_login_status" != 200 ]; then
  printf 'Login with rotated password returned HTTP %s: ' "$password_login_status" >&2
  cat "$temporary_root/password-login-response.json" >&2
  exit 1
fi
assert_field "$temporary_root/password-login-response.json" principal.user_id "$owner_user_id"
cat >"$temporary_root/password-restore.json" <<'EOF'
{"current_password":"stage3-admin-password-updated","new_password":"stage3-admin-password"}
EOF
gateway_request POST /api/admin/account/password "$temporary_root/password-restore.json" \
  "$temporary_root/password-restore-response.json" 200
assert_field "$temporary_root/password-restore-response.json" status changed

cat >"$temporary_root/local-user-create.json" <<'EOF'
{
  "email":"stage3-user@example.com",
  "display_name":"Stage 3 User",
  "password":"stage3-user-password",
  "role":"member"
}
EOF
gateway_request POST /api/admin/directory/users "$temporary_root/local-user-create.json" "$temporary_root/local-user.json" 200
directory_user_id=$(json_field "$temporary_root/local-user.json" user.id)
directory_membership_id=$(json_field "$temporary_root/local-user.json" membership.id)
if grep -q 'stage3-user-password' "$temporary_root/local-user.json"; then
  echo "Directory response leaked the local-user password" >&2
  exit 1
fi

cat >"$temporary_root/local-user-suspend.json" <<'EOF'
{
  "email":"stage3-user@example.com",
  "display_name":"Stage 3 Operator",
  "role":"member",
  "active":false
}
EOF
gateway_request POST "/api/admin/directory/memberships/${directory_membership_id}" \
  "$temporary_root/local-user-suspend.json" "$temporary_root/local-user-suspended.json" 200
assert_field "$temporary_root/local-user-suspended.json" membership.active false

cat >"$temporary_root/local-user-restore.json" <<'EOF'
{
  "email":"stage3-user@example.com",
  "display_name":"Stage 3 Operator",
  "role":"member",
  "active":true
}
EOF
gateway_request POST "/api/admin/directory/memberships/${directory_membership_id}" \
  "$temporary_root/local-user-restore.json" "$temporary_root/local-user-restored.json" 200
assert_field "$temporary_root/local-user-restored.json" membership.active true

printf '{"active":false}' >"$temporary_root/local-user-disable.json"
gateway_request POST "/api/admin/directory/users/${directory_user_id}/active" \
  "$temporary_root/local-user-disable.json" "$temporary_root/local-user-disabled.json" 200
assert_field "$temporary_root/local-user-disabled.json" status updated
printf '{"active":true}' >"$temporary_root/local-user-activate.json"
gateway_request POST "/api/admin/directory/users/${directory_user_id}/active" \
  "$temporary_root/local-user-activate.json" "$temporary_root/local-user-activated.json" 200
assert_field "$temporary_root/local-user-activated.json" status updated

gateway_request GET /api/admin/directory - "$temporary_root/directory-updated.json" 200
node -e '
  const payload = require(process.argv[1]);
  const user = payload.users.find((item) => item.user.id === process.argv[2]);
  if (!user || !user.user.active || !user.membership.active || user.membership.display_name !== "Stage 3 Operator") {
    process.exit(1);
  }
' "$temporary_root/directory-updated.json" "$directory_user_id"
owner_user_id=$directory_user_id

cat >"$temporary_root/scim-token-create.json" <<'EOF'
{
  "name":"Stage 3 directory",
  "scopes":["scim:read","scim:write"]
}
EOF
gateway_request POST /api/admin/provisioning/scim-tokens \
  "$temporary_root/scim-token-create.json" "$temporary_root/scim-token-created.json" 200 \
  "$temporary_root/scim-token-headers.txt"
scim_token_id=$(json_field "$temporary_root/scim-token-created.json" token.id)
scim_credential=$(json_field "$temporary_root/scim-token-created.json" credential)
if ! printf '%s' "$scim_credential" | grep -q '^ant_scim_'; then
  echo "SCIM issuance did not disclose the one-time credential" >&2
  exit 1
fi
if ! grep -iq '^cache-control: no-store' "$temporary_root/scim-token-headers.txt"; then
  echo "SCIM issuance response is cacheable" >&2
  exit 1
fi
scim_discovery_status=$(curl -sS -o "$temporary_root/scim-service-provider.json" -w '%{http_code}' \
  -H 'accept: application/scim+json' -H "authorization: Bearer $scim_credential" \
  "$gateway_url/scim/v2/ServiceProviderConfig")
if [ "$scim_discovery_status" != 200 ] ||
  ! grep -q 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig' \
    "$temporary_root/scim-service-provider.json"; then
  echo "SCIM credential did not reach Identity through Edge" >&2
  exit 1
fi
gateway_request GET /api/admin/provisioning/scim-tokens - "$temporary_root/scim-tokens.json" 200
if grep -q "$scim_credential" "$temporary_root/scim-tokens.json" || grep -q '"credential"' "$temporary_root/scim-tokens.json"; then
  echo "SCIM token list redisclosed a credential" >&2
  exit 1
fi
node -e '
  const payload = require(process.argv[1]);
  const token = payload.tokens?.find((item) => item.id === process.argv[2]);
  if (!token || token.revoked_at) process.exit(1);
' "$temporary_root/scim-tokens.json" "$scim_token_id"
printf '{}' >"$temporary_root/scim-token-revoke.json"
gateway_request POST "/api/admin/provisioning/scim-tokens/${scim_token_id}/revoke" \
  "$temporary_root/scim-token-revoke.json" "$temporary_root/scim-token-revoked.json" 200
gateway_request GET /api/admin/provisioning/scim-tokens - "$temporary_root/scim-tokens-after-revoke.json" 200
node -e '
  const payload = require(process.argv[1]);
  const token = payload.tokens?.find((item) => item.id === process.argv[2]);
  if (!token?.revoked_at) process.exit(1);
' "$temporary_root/scim-tokens-after-revoke.json" "$scim_token_id"

node scripts/identity-closeout/client.mjs "$gateway_url" "$jaeger_url"
node scripts/identity-closeout/oidc-client.mjs "$gateway_url" "$jaeger_url" \
  "$ANTNEST_OIDC_TEST_PORT" "$temporary_root/certs/tls.crt" "$temporary_root/oidc-canaries.json"
compose logs --no-color edge-gateway admin-console identity-service >"$temporary_root/identity-service-logs.txt"
node scripts/identity-closeout/check-oidc-logs.mjs \
  "$temporary_root/oidc-canaries.json" "$temporary_root/identity-service-logs.txt"

gateway_request GET /api/admin/model-catalog - "$temporary_root/model-catalog.json" 200
node -e '
  const payload = require(process.argv[1]);
  const deepseek = payload.providers?.find((provider) => provider.provider_key === "deepseek");
  const model = deepseek?.models?.find((candidate) => candidate.model_id === "deepseek-v4-pro");
  const custom = payload.providers?.find((provider) => provider.provider_key === "openai-compatible");
  if (!payload.revision || !model || model.context_window !== 1000000 || !custom?.custom) process.exit(1);
' "$temporary_root/model-catalog.json"

cat >"$temporary_root/model.json" <<'EOF'
{
  "display_name":"Stage 3 model",
  "api_key":"stage3-model-secret",
  "model":{
    "base_url":"http://stage3-model:8080/v1",
    "model":"stage3-model",
    "context_window":8192,
    "max_output_tokens":1024,
    "supports_images":false
  }
}
EOF
gateway_request POST /api/admin/model-profiles "$temporary_root/model.json" "$temporary_root/model-response.json" 201
model_profile_id=$(json_field "$temporary_root/model-response.json" model_profile_id)
model_revision_id=$(json_field "$temporary_root/model-response.json" revision_id)
gateway_request POST /api/admin/model-profiles "$temporary_root/model.json" "$temporary_root/model-replay.json" 201
assert_field "$temporary_root/model-replay.json" model_profile_id "$model_profile_id"
assert_field "$temporary_root/model-replay.json" revision_id "$model_revision_id"
gateway_request GET /api/admin/model-profiles - "$temporary_root/models-after-replay.json" 200
assert_field "$temporary_root/models-after-replay.json" items.length 1
if grep -q 'stage3-model-secret' "$temporary_root/model-response.json"; then
  echo "Model response leaked the Provider secret" >&2
  exit 1
fi

cat >"$temporary_root/template-missing-image.json" <<EOF
{
  "name":"Missing image must not publish",
  "model_profile_revision_id":"$model_revision_id",
  "runtime":{"image_ref":"antnest/not-installed:${COMPOSE_PROJECT_NAME}"}
}
EOF
gateway_request POST /api/admin/templates "$temporary_root/template-missing-image.json" \
  "$temporary_root/template-missing-image-response.json" 400
assert_field "$temporary_root/template-missing-image-response.json" code runtime_image_invalid
gateway_request GET /api/admin/templates - "$temporary_root/templates-after-missing-image.json" 200
assert_field "$temporary_root/templates-after-missing-image.json" items.length 0

cat >"$temporary_root/template.json" <<EOF
{
  "name":"Stage 3 Template",
  "model_profile_revision_id":"$model_revision_id",
  "system_prompt":"Operate as a reliable enterprise assistant.",
  "max_model_requests":8,
  "runtime":{"image_ref":"antnest/antnest-runtime:local"}
}
EOF
gateway_request POST /api/admin/templates "$temporary_root/template.json" "$temporary_root/template-response.json" 201
template_id=$(json_field "$temporary_root/template-response.json" template_id)
assert_field "$temporary_root/template-response.json" runtime.image_ref "$runtime_image"
assert_field "$temporary_root/template-response.json" runtime.image_source antnest/antnest-runtime:local
gateway_request POST /api/admin/templates "$temporary_root/template.json" "$temporary_root/template-replay.json" 201
assert_field "$temporary_root/template-replay.json" template_id "$template_id"
assert_field "$temporary_root/template-replay.json" revision 1
assert_field "$temporary_root/template-replay.json" runtime.image_ref "$runtime_image"
gateway_request GET /api/admin/templates - "$temporary_root/templates-after-replay.json" 200
assert_field "$temporary_root/templates-after-replay.json" items.length 1

cat >"$temporary_root/model-secondary.json" <<'EOF'
{
  "display_name":"Stage 3 secondary model",
  "api_key":"stage3-secondary-model-secret",
  "model":{
    "base_url":"http://stage3-model:8080/v1",
    "model":"stage3-model-secondary",
    "context_window":8192,
    "max_output_tokens":1024,
    "supports_images":false
  }
}
EOF
gateway_request POST /api/admin/model-profiles "$temporary_root/model-secondary.json" \
  "$temporary_root/model-secondary-response.json" 201
secondary_model_profile_id=$(json_field "$temporary_root/model-secondary-response.json" model_profile_id)
secondary_model_revision_id=$(json_field "$temporary_root/model-secondary-response.json" revision_id)

cat >"$temporary_root/template-secondary.json" <<EOF
{
  "name":"Stage 3 Secondary Template",
  "model_profile_revision_id":"$secondary_model_revision_id",
  "system_prompt":"Operate as a secondary enterprise assistant.",
  "max_model_requests":8
}
EOF
gateway_request POST /api/admin/templates "$temporary_root/template-secondary.json" \
  "$temporary_root/template-secondary-response.json" 201
secondary_template_id=$(json_field "$temporary_root/template-secondary-response.json" template_id)
assert_field "$temporary_root/template-secondary-response.json" runtime.image_ref "$runtime_image"

gateway_request GET "/api/admin/model-profiles?limit=1" - "$temporary_root/models-page-1.json" 200
model_after_id=$(json_field "$temporary_root/models-page-1.json" next_after_id)
gateway_request GET "/api/admin/model-profiles?limit=1&after_id=${model_after_id}" - \
  "$temporary_root/models-page-2.json" 200
gateway_request GET "/api/admin/templates?limit=1" - "$temporary_root/templates-page-1.json" 200
template_after_id=$(json_field "$temporary_root/templates-page-1.json" next_after_id)
gateway_request GET "/api/admin/templates?limit=1&after_id=${template_after_id}" - \
  "$temporary_root/templates-page-2.json" 200
node -e '
  const firstModels = require(process.argv[1]).items ?? [];
  const secondModels = require(process.argv[2]).items ?? [];
  const firstTemplates = require(process.argv[3]).items ?? [];
  const secondTemplates = require(process.argv[4]).items ?? [];
  const actualModels = [...firstModels, ...secondModels].map((item) => item.model_profile_id).sort();
  const actualTemplates = [...firstTemplates, ...secondTemplates].map((item) => item.template_id).sort();
  const expectedModels = [process.argv[5], process.argv[6]].sort();
  const expectedTemplates = [process.argv[7], process.argv[8]].sort();
  if (new Set(actualModels).size !== 2 || JSON.stringify(actualModels) !== JSON.stringify(expectedModels)) process.exit(1);
  if (new Set(actualTemplates).size !== 2 || JSON.stringify(actualTemplates) !== JSON.stringify(expectedTemplates)) process.exit(2);
' "$temporary_root/models-page-1.json" "$temporary_root/models-page-2.json" \
  "$temporary_root/templates-page-1.json" "$temporary_root/templates-page-2.json" \
  "$model_profile_id" "$secondary_model_profile_id" "$template_id" "$secondary_template_id"

cat >"$temporary_root/agent.json" <<EOF
{"owner_user_id":"$owner_user_id","name":"Stage 3 Agent","template_id":"$template_id","template_revision":1}
EOF
gateway_request POST /api/admin/agents "$temporary_root/agent.json" "$temporary_root/agent-response.json" 202 "$temporary_root/agent-headers.txt"
agent_id=$(json_field "$temporary_root/agent-response.json" agent.agent_id)
assert_field "$temporary_root/agent-response.json" agent.owner_user_id "$owner_user_id"
node -e '
  const payload = require(process.argv[1]);
  if (Object.hasOwn(payload.agent, "organization_id")) {
    throw new Error("Browser Agent response exposed internal organization scope");
  }
' "$temporary_root/agent-response.json"
create_request_id=$(json_field "$temporary_root/agent-response.json" operation.request_id)
wait_operation "$create_request_id" "$temporary_root/create-operation.json"
compose exec -T stage3-model node --input-type=module -e '
  import assert from "node:assert/strict";
  const [agentID, organizationID, ownerUserID] = process.argv.slice(1);
  const url = new URL(`http://agent-controller:8080/internal/agents/${agentID}`);
  url.searchParams.set("organization_id", organizationID);
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, "Owner service must resolve the scoped Agent");
  const agent = await response.json();
  assert.equal(agent.organization_id, organizationID);
  assert.equal(agent.owner_user_id, ownerUserID);
  url.searchParams.set("organization_id", "stage3-unrelated-organization");
  const foreign = await fetch(url, { signal: AbortSignal.timeout(10000) });
  assert.equal(foreign.status, 404, "Another organization must not resolve the Agent");
' "$agent_id" "$organization_id" "$owner_user_id"
wait_agent_ready "$agent_id" "$temporary_root/created-agent.json"
assert_field "$temporary_root/created-agent.json" configuration.runtime.image_source antnest/antnest-runtime:local
node -e '
  const payload = require(process.argv[1]);
  const configuration = payload.configuration;
  if (configuration?.template?.template_id !== process.argv[2] ||
      configuration.template.revision !== 1 ||
      configuration.template.name !== "Stage 3 Template") process.exit(1);
  if (configuration?.model_profile?.revision_id !== process.argv[3] ||
      configuration.model_profile.revision !== 1 ||
      configuration.model_profile.name !== "Stage 3 model" ||
      configuration.model_profile.model?.model !== "stage3-model") process.exit(2);
  const imageRef = configuration.runtime?.image_ref ?? "";
  const immutableImageRef = /^sha256:[a-f0-9]{64}$/.test(imageRef) || imageRef.includes("@sha256:");
  if (configuration.max_model_requests !== 8 ||
      configuration.context_policy_version !== "context-v1" ||
      !immutableImageRef) process.exit(3);
  const serialized = JSON.stringify(payload);
  if (serialized.includes("credential_ref") || serialized.includes("credential_version") ||
      serialized.includes("runtime_execution_id") || serialized.includes("mcp_endpoint")) process.exit(4);
' "$temporary_root/created-agent.json" "$template_id" "$model_revision_id"

cat >"$temporary_root/model-revision.json" <<'EOF'
{
  "display_name":"Stage 3 model v2",
  "api_key":"stage3-model-secret-v2",
  "model":{
    "base_url":"http://stage3-model:8080/v1",
    "model":"stage3-model-v2",
    "context_window":16384,
    "max_output_tokens":2048,
    "supports_images":false
  }
}
EOF
gateway_request POST "/api/admin/model-profiles/${model_profile_id}/revisions" \
  "$temporary_root/model-revision.json" "$temporary_root/model-revision-response.json" 201
model_revision_v2_id=$(json_field "$temporary_root/model-revision-response.json" revision_id)
assert_field "$temporary_root/model-revision-response.json" revision 2
if grep -q 'stage3-model-secret-v2' "$temporary_root/model-revision-response.json"; then
  echo "Model revision response leaked the Provider secret" >&2
  exit 1
fi

cat >"$temporary_root/template-revision.json" <<EOF
{
  "name":"Stage 3 Template v2",
  "model_profile_revision_id":"$model_revision_v2_id",
  "system_prompt":"Operate with the revised configuration.",
  "max_model_requests":12,
  "runtime":{"image_ref":"$runtime_image"}
}
EOF
gateway_request POST "/api/admin/templates/${template_id}/revisions" \
  "$temporary_root/template-revision.json" "$temporary_root/template-revision-response.json" 201
assert_field "$temporary_root/template-revision-response.json" revision 2
assert_field "$temporary_root/template-revision-response.json" runtime.image_ref "$runtime_image"
assert_field "$temporary_root/template-revision-response.json" runtime.image_source antnest/antnest-runtime:local

gateway_request GET "/api/admin/model-profiles/${model_profile_id}" - \
  "$temporary_root/current-model.json" 200
assert_field "$temporary_root/current-model.json" revision 2
gateway_request GET "/api/admin/model-profile-revisions/${model_revision_id}" - \
  "$temporary_root/historical-model.json" 200
node -e '
  const payload = require(process.argv[1]);
  if (payload.revision !== 1 || payload.revision_id !== process.argv[2] ||
      payload.model?.model !== "stage3-model" || payload.model?.context_window !== 8192) process.exit(1);
  const serialized = JSON.stringify(payload);
  if (serialized.includes("credential_ref") || serialized.includes("credential_version")) process.exit(2);
' "$temporary_root/historical-model.json" "$model_revision_id"

gateway_request GET "/api/admin/templates/${template_id}" - \
  "$temporary_root/current-template.json" 200
assert_field "$temporary_root/current-template.json" revision 2
gateway_request GET "/api/admin/templates/${template_id}/revisions/1" - \
  "$temporary_root/historical-template.json" 200
node -e '
  const payload = require(process.argv[1]);
  if (payload.revision !== 1 || payload.model_profile_revision_id !== process.argv[2] ||
      payload.system_prompt !== "Operate as a reliable enterprise assistant." ||
      payload.max_model_requests !== 8) process.exit(1);
' "$temporary_root/historical-template.json" "$model_revision_id"

gateway_request GET "/api/admin/agents/${agent_id}" - \
  "$temporary_root/agent-after-catalog-revisions.json" 200
node -e '
  const configuration = require(process.argv[1]).configuration;
  if (configuration?.template?.revision !== 1 ||
      configuration?.model_profile?.revision_id !== process.argv[2] ||
      configuration?.model_profile?.model?.model !== "stage3-model" ||
      configuration?.max_model_requests !== 8) process.exit(1);
' "$temporary_root/agent-after-catalog-revisions.json" "$model_revision_id"
trace_id=$(awk 'tolower($1) == "x-antnest-trace-id:" { gsub("\r", "", $2); print $2 }' "$temporary_root/agent-headers.txt" | tail -1)
if ! printf '%s' "$trace_id" | grep -Eq '^[a-f0-9]{32}$'; then
  printf 'Gateway trace ID is invalid: %s\n' "$trace_id" >&2
  exit 1
fi
initial_runtime=$(json_field "$temporary_root/created-agent.json" runtime.runtime_revision)

gateway_request GET "/api/admin/agents/${agent_id}/events" - "$temporary_root/events.json" 200
node -e 'const p=require(process.argv[1]); if (!Array.isArray(p.events) || p.events.length === 0) process.exit(1)' "$temporary_root/events.json"
event_trace_id "$temporary_root/events.json" agent_ready "$create_request_id" >/dev/null

set +e
stream_status=$(curl -s -N --max-time 2 -o /dev/null -w '%{http_code}' \
  -b "$cookie_jar" "$gateway_url/api/admin/agents/${agent_id}/events/watch?after_sequence=2")
stream_result=$?
set -e
if [ "$stream_status" != 200 ] || { [ "$stream_result" != 0 ] && [ "$stream_result" != 28 ]; }; then
  printf 'Idle Agent event stream status=%s curl_result=%s\n' "$stream_status" "$stream_result" >&2
  exit 1
fi

printf '{}' >"$temporary_root/empty.json"
gateway_request POST "/api/admin/agents/${agent_id}/disable" "$temporary_root/empty.json" "$temporary_root/disable.json" 202
disable_request_id=$(json_field "$temporary_root/disable.json" request_id)
wait_operation "$disable_request_id" "$temporary_root/disable-operation.json"
gateway_request GET "/api/admin/agents/${agent_id}" - "$temporary_root/disabled-agent.json" 200
assert_field "$temporary_root/disabled-agent.json" lifecycle_state created
assert_field "$temporary_root/disabled-agent.json" activation_state disabled

gateway_request POST "/api/admin/agents/${agent_id}/enable" "$temporary_root/empty.json" "$temporary_root/enable.json" 202
enable_request_id=$(json_field "$temporary_root/enable.json" request_id)
wait_operation "$enable_request_id" "$temporary_root/enable-operation.json"
wait_agent_ready "$agent_id" "$temporary_root/enabled-agent.json"

cat >"$temporary_root/rebuild.json" <<EOF
{"template_id":"$template_id","template_revision":1}
EOF
gateway_request POST "/api/admin/agents/${agent_id}/rebuild" "$temporary_root/rebuild.json" "$temporary_root/rebuild-response.json" 202
rebuild_request_id=$(json_field "$temporary_root/rebuild-response.json" request_id)
wait_operation "$rebuild_request_id" "$temporary_root/rebuild-operation.json"
wait_agent_ready "$agent_id" "$temporary_root/rebuilt-agent.json"
rebuilt_runtime=$(json_field "$temporary_root/rebuilt-agent.json" runtime.runtime_revision)
if [ "$rebuilt_runtime" = "$initial_runtime" ]; then
  echo "Agent rebuild did not publish a new Runtime revision" >&2
  exit 1
fi

cat >"$temporary_root/workspace-login.json" <<'EOF'
{"organization_slug":"stage3","email":"stage3-user@example.com","password":"stage3-user-password"}
EOF
workspace_login_status=$(curl -sS -o "$temporary_root/workspace-login-response.json" -w '%{http_code}' \
  -c "$workspace_cookie_jar" -H 'accept: application/json' -H 'content-type: application/json' \
  --data-binary "@$temporary_root/workspace-login.json" "$gateway_url/api/session/login")
if [ "$workspace_login_status" != 200 ]; then
  printf 'Workspace login returned HTTP %s: ' "$workspace_login_status" >&2
  cat "$temporary_root/workspace-login-response.json" >&2
  exit 1
fi
workspace_status=$(curl -sS -o "$temporary_root/workspace-bootstrap.json" -w '%{http_code}' \
  -b "$workspace_cookie_jar" -H 'accept: application/json' "$gateway_url/api/app/bootstrap")
if [ "$workspace_status" != 200 ]; then
  printf 'Workspace bootstrap returned HTTP %s: ' "$workspace_status" >&2
  cat "$temporary_root/workspace-bootstrap.json" >&2
  exit 1
fi
node -e '
  const payload = require(process.argv[1]);
  const agent = payload.agents?.find((item) => item.agent_id === process.argv[2]);
  if (!agent || agent.availability !== "ready") process.exit(1);
  if (JSON.stringify(payload).includes("agent_access_subject")) process.exit(2);
' "$temporary_root/workspace-bootstrap.json" "$agent_id"
workspace_page_status=$(curl -sS -o "$temporary_root/workspace.html" -w '%{http_code}' \
  -b "$workspace_cookie_jar" "$gateway_url/workspace/")
if [ "$workspace_page_status" != 200 ] || ! grep -q '<title>Antnest Workspace</title>' "$temporary_root/workspace.html"; then
  echo "Agent workspace application was not served through Edge Gateway" >&2
  exit 1
fi
workspace_cookie=$(node -e '
  const fs = require("node:fs");
  const cookies = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/u).flatMap((line) => {
    const normalized = line.replace(/^#HttpOnly_/u, "");
    if (!normalized || normalized.startsWith("#")) return [];
    const fields = normalized.split("\t");
    return fields.length >= 7 ? [`${fields[5]}=${fields[6]}`] : [];
  });
  process.stdout.write(cookies.join("; "));
' "$workspace_cookie_jar")
if [ -z "$workspace_cookie" ]; then
  echo "Workspace browser session cookie is missing" >&2
  exit 1
fi
docker run --rm --network "${COMPOSE_PROJECT_NAME}_development" \
  -e "ANTNEST_STAGE3_GATEWAY_WS=ws://edge-gateway:8080/api/app/agents/${agent_id}/acp" \
  -e "ANTNEST_STAGE3_GATEWAY_ORIGIN=http://edge-gateway:8080" \
  -e "ANTNEST_STAGE3_COOKIE=$workspace_cookie" \
  -v "$repository_root/scripts/stage3-workspace-client.mjs:/app/stage3-workspace-client.mjs:ro" \
  antnest/agent-acp-service:local node /app/stage3-workspace-client.mjs \
  >"$temporary_root/workspace-acp-evidence.json"
assert_field "$temporary_root/workspace-acp-evidence.json" status passed

docker run --rm --network "${COMPOSE_PROJECT_NAME}_development" \
  -e "ANTNEST_STAGE3_AGENT_ID=$agent_id" \
  -v "$repository_root/scripts:/app/scripts:ro" \
  antnest/agent-acp-service:local node /app/scripts/identity-closeout/acp-session-client.mjs \
  >"$temporary_root/acp-session-evidence.json"
assert_field "$temporary_root/acp-session-evidence.json" status passed
cat "$temporary_root/acp-session-evidence.json"

if [ "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" = true ]; then
  [ "$keep_stack" = false ] || { echo 'ACP fault injection requires disposable stack' >&2; exit 1; }
  ANTNEST_E2E_DISPOSABLE=true ANTNEST_E2E_ACP_CONTAINER=$(compose ps -q agent-acp-service) \
    sh scripts/e2e-acp-closeout.sh >"$temporary_root/acp-closeout.json"
  assert_field "$temporary_root/acp-closeout.json" status passed
fi

if [ "${ANTNEST_E2E_MANAGED_MCP:-false}" = true ]; then
  TEST_ORGANIZATION_ID="$organization_id" TEST_OWNER_ID="$owner_user_id" \
    TEST_USER_COOKIE="$workspace_cookie" sh scripts/e2e-managed-mcp.sh \
    >"$temporary_root/managed-mcp-evidence.json"
  assert_field "$temporary_root/managed-mcp-evidence.json" status passed
  assert_field "$temporary_root/managed-mcp-evidence.json" version "${ANTNEST_E2E_MANAGED_MCP_VERSION:-1}"
fi

node scripts/stage3-lifecycle-trace-assert.mjs "$jaeger_url" "$trace_id" \
  "$temporary_root/create-operation.json" "$cookie_jar" \
  >"$temporary_root/lifecycle-trace-evidence.json"

if [ "$keep_stack" = false ]; then
  gateway_request POST "/api/admin/agents/${agent_id}/delete" "$temporary_root/empty.json" "$temporary_root/delete.json" 202
  delete_request_id=$(json_field "$temporary_root/delete.json" request_id)
  wait_operation "$delete_request_id" "$temporary_root/delete-operation.json"
  gateway_request GET "/api/admin/agents/${agent_id}" - "$temporary_root/deleted-agent.json" 200
  assert_field "$temporary_root/deleted-agent.json" lifecycle_state deleted
  gateway_request GET "/api/admin/agents" - "$temporary_root/current-agents.json" 200
  gateway_request GET "/api/admin/agents?view=deleted" - "$temporary_root/agents-with-deleted.json" 200
  node -e '
    const current = require(process.argv[1]);
    const retained = require(process.argv[2]);
    const agentID = process.argv[3];
    if (current.items?.some((item) => item.agent_id === agentID)) process.exit(2);
    const deleted = retained.items?.find((item) => item.agent_id === agentID);
    if (deleted?.desired_state !== "deleted" || deleted?.lifecycle_state !== "deleted") process.exit(3);
  ' "$temporary_root/current-agents.json" "$temporary_root/agents-with-deleted.json" "$agent_id"
  if docker inspect "antnest-runtime-${agent_id}" >/dev/null 2>&1; then
    echo "Deleted Agent retained its Runtime container" >&2
    exit 1
  fi
  if docker volume inspect "antnest-workspace-${agent_id}" >/dev/null 2>&1; then
    echo "Deleted Agent retained its workspace volume" >&2
    exit 1
  fi
fi

for service in runtime-controller agent-acp-service identity-service agent-controller admin-console agent-ui; do
  container=$(compose ps -q "$service")
  bindings=$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$container")
  if [ "$bindings" != 0 ]; then
    printf '%s unexpectedly publishes %s host ports\n' "$service" "$bindings" >&2
    exit 1
  fi
done
edge_container=$(compose ps -q edge-gateway)
if [ "$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$edge_container")" != 1 ]; then
  echo "Edge Gateway is not the sole application ingress" >&2
  exit 1
fi

echo "Stage 3 administrator lifecycle, Agent workspace ACP, and Jaeger E2E passed"
if [ "$keep_stack" = true ]; then
  printf 'Stage 3 acceptance stack retained at %s (project %s)\n' "$gateway_url" "$COMPOSE_PROJECT_NAME"
fi
