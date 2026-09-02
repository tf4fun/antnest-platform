#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository_root"

port_base=$((42000 + ($$ % 8000)))
network_octet=$((1 + ($$ % 200)))
export COMPOSE_PROJECT_NAME="antnest-stage3-e2e-$$"
export ANTNEST_POSTGRES_HOST_PORT=$port_base
export ANTNEST_EDGE_HOST_PORT=$((port_base + 1))
export ANTNEST_JAEGER_UI_HOST_PORT=$((port_base + 2))
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
agent_id=""

compose() {
  docker compose -f compose.yaml -f compose.stage3.yaml --profile stage3 --profile observability "$@"
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then
    compose ps >&2 || true
    compose logs --no-color --tail=200 edge-gateway admin-console identity-service \
      agent-controller runtime-controller runtime-egress jaeger >&2 || true
    if [ -n "$agent_id" ]; then
      docker logs --tail=200 "antnest-runtime-${agent_id}" >&2 || true
    fi
  fi
  docker ps -aq --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME" 2>/dev/null |
    while IFS= read -r runtime_container; do
      [ -z "$runtime_container" ] || docker rm -f "$runtime_container" >/dev/null 2>&1 || true
    done
  docker volume ls -q --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME" 2>/dev/null |
    while IFS= read -r runtime_volume; do
      [ -z "$runtime_volume" ] || docker volume rm -f "$runtime_volume" >/dev/null 2>&1 || true
    done
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "${temporary_root:?}"
  exit "$status"
}
trap cleanup EXIT INT TERM

json_field() {
  node -e '
    const fs = require("node:fs");
    let value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const segment of process.argv[2].split(".")) value = value?.[segment];
    if (value === undefined) process.exit(2);
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
    idempotency_header="Idempotency-Key: stage3-e2e-${method}-${path}"
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

compose up -d --wait

cat >"$temporary_root/login.json" <<'EOF'
{"organization_slug":"stage3","email":"stage3-admin@example.com","password":"stage3-admin-password"}
EOF
gateway_request POST /api/session/login "$temporary_root/login.json" "$temporary_root/login-response.json" 200
organization_id=$(json_field "$temporary_root/login-response.json" principal.organization_id)
owner_user_id=$(json_field "$temporary_root/login-response.json" principal.user_id)

gateway_request GET /api/admin/directory - "$temporary_root/directory.json" 200
assert_field "$temporary_root/directory.json" users.0.user.id "$owner_user_id"

cat >"$temporary_root/model.json" <<'EOF'
{
  "profile_key":"stage3-model",
  "display_name":"Stage 3 model",
  "api_key":"stage3-provider-secret",
  "model":{
    "base_url":"https://api.example.com/v1",
    "model":"stage3-model",
    "context_window":8192,
    "max_output_tokens":1024,
    "supports_images":false
  }
}
EOF
gateway_request POST /api/admin/model-profiles "$temporary_root/model.json" "$temporary_root/model-response.json" 201
model_revision_id=$(json_field "$temporary_root/model-response.json" revision_id)
if grep -q 'stage3-provider-secret' "$temporary_root/model-response.json"; then
  echo "Model response leaked the Provider secret" >&2
  exit 1
fi

cat >"$temporary_root/template.json" <<EOF
{
  "template_key":"stage3-template",
  "name":"Stage 3 Template",
  "model_profile_revision_id":"$model_revision_id",
  "system_prompt":"Operate as a reliable enterprise assistant.",
  "max_model_requests":8
}
EOF
gateway_request POST /api/admin/templates "$temporary_root/template.json" "$temporary_root/template-response.json" 201
template_id=$(json_field "$temporary_root/template-response.json" template_id)

cat >"$temporary_root/agent.json" <<EOF
{"owner_user_id":"$owner_user_id","name":"Stage 3 Agent","template_id":"$template_id","template_revision":1}
EOF
gateway_request POST /api/admin/agents "$temporary_root/agent.json" "$temporary_root/agent-response.json" 202 "$temporary_root/agent-headers.txt"
agent_id=$(json_field "$temporary_root/agent-response.json" agent.agent_id)
assert_field "$temporary_root/agent-response.json" agent.organization_id "$organization_id"
create_request_id=$(json_field "$temporary_root/agent-response.json" operation.request_id)
wait_operation "$create_request_id" "$temporary_root/create-operation.json"
gateway_request GET "/api/admin/agents/${agent_id}" - "$temporary_root/created-agent.json" 200
assert_field "$temporary_root/created-agent.json" lifecycle_state available
trace_id=$(awk 'tolower($1) == "x-antnest-trace-id:" { gsub("\r", "", $2); print $2 }' "$temporary_root/agent-headers.txt" | tail -1)
if ! printf '%s' "$trace_id" | grep -Eq '^[a-f0-9]{32}$'; then
  printf 'Gateway trace ID is invalid: %s\n' "$trace_id" >&2
  exit 1
fi
initial_runtime=$(json_field "$temporary_root/created-agent.json" runtime.runtime_revision)

gateway_request GET "/api/admin/agents/${agent_id}/events" - "$temporary_root/events.json" 200
node -e 'const p=require(process.argv[1]); if (!Array.isArray(p.events) || p.events.length === 0) process.exit(1)' "$temporary_root/events.json"
worker_trace_id=$(event_trace_id "$temporary_root/events.json" agent_ready "$create_request_id")

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
assert_field "$temporary_root/disabled-agent.json" lifecycle_state disabled

gateway_request POST "/api/admin/agents/${agent_id}/enable" "$temporary_root/empty.json" "$temporary_root/enable.json" 202
enable_request_id=$(json_field "$temporary_root/enable.json" request_id)
wait_operation "$enable_request_id" "$temporary_root/enable-operation.json"
gateway_request GET "/api/admin/agents/${agent_id}" - "$temporary_root/enabled-agent.json" 200
assert_field "$temporary_root/enabled-agent.json" lifecycle_state available

cat >"$temporary_root/rebuild.json" <<EOF
{"template_id":"$template_id","template_revision":1}
EOF
gateway_request POST "/api/admin/agents/${agent_id}/rebuild" "$temporary_root/rebuild.json" "$temporary_root/rebuild-response.json" 202
rebuild_request_id=$(json_field "$temporary_root/rebuild-response.json" request_id)
wait_operation "$rebuild_request_id" "$temporary_root/rebuild-operation.json"
gateway_request GET "/api/admin/agents/${agent_id}" - "$temporary_root/rebuilt-agent.json" 200
rebuilt_runtime=$(json_field "$temporary_root/rebuilt-agent.json" runtime.runtime_revision)
if [ "$rebuilt_runtime" = "$initial_runtime" ]; then
  echo "Agent rebuild did not publish a new Runtime revision" >&2
  exit 1
fi

node scripts/stage3-trace-assert.mjs "$jaeger_url" "$trace_id" \
  edge-gateway admin-console identity-service agent-controller \
  >"$temporary_root/admission-trace-evidence.json"
node scripts/stage3-trace-assert.mjs "$jaeger_url" "$worker_trace_id" \
  agent-controller antnest-runtime-egress \
  >"$temporary_root/worker-trace-evidence.json"
node scripts/stage3-lifecycle-trace-assert.mjs "$jaeger_url" "$create_request_id" create \
  agent-controller antnest-runtime-egress runtime-controller \
  >"$temporary_root/lifecycle-trace-evidence.json"

gateway_request POST "/api/admin/agents/${agent_id}/delete" "$temporary_root/empty.json" "$temporary_root/delete.json" 202
delete_request_id=$(json_field "$temporary_root/delete.json" request_id)
wait_operation "$delete_request_id" "$temporary_root/delete-operation.json"
gateway_request GET "/api/admin/agents/${agent_id}" - "$temporary_root/deleted-agent.json" 200
assert_field "$temporary_root/deleted-agent.json" lifecycle_state deleted
if docker inspect "antnest-runtime-${agent_id}" >/dev/null 2>&1; then
  echo "Deleted Agent retained its Runtime container" >&2
  exit 1
fi
if docker volume inspect "antnest-workspace-${agent_id}" >/dev/null 2>&1; then
  echo "Deleted Agent retained its workspace volume" >&2
  exit 1
fi

for service in runtime-controller identity-service agent-controller admin-console; do
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

echo "Stage 3A administrator lifecycle and Jaeger E2E passed"
