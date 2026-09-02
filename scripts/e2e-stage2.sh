#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository_root"

port_base=$((40000 + ($$ % 10000)))
network_octet=$((1 + ($$ % 200)))
export COMPOSE_PROJECT_NAME="antnest-stage2-e2e-$$"
export ANTNEST_POSTGRES_HOST_PORT=$port_base
export ANTNEST_RUNTIME_CONTROLLER_HOST_PORT=$((port_base + 1))
export ANTNEST_ACP_HOST_PORT=$((port_base + 2))
export ANTNEST_AGENT_CONTROLLER_HOST_PORT=$((port_base + 3))
export ANTNEST_JAEGER_UI_HOST_PORT=$((port_base + 4))
export ANTNEST_IDENTITY_HOST_PORT=$((port_base + 5))
export ANTNEST_RUNTIME_CONTROLLER_SCOPE="$COMPOSE_PROJECT_NAME"
export ANTNEST_RUNTIME_MANAGEMENT_NETWORK="${COMPOSE_PROJECT_NAME}-runtime-management"
export ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME="${COMPOSE_PROJECT_NAME}-system-skills"
export ANTNEST_RUNTIME_MANAGEMENT_SUBNET="10.253.${network_octet}.0/24"
export ANTNEST_EGRESS_IPV4="10.253.${network_octet}.3"
export ANTNEST_JAEGER_RUNTIME_IPV4="10.253.${network_octet}.4"
export ANTNEST_EGRESS_CONTROL_SUBNET="10.252.${network_octet}.0/24"
export ANTNEST_EGRESS_CONTROL_IPV4="10.252.${network_octet}.3"
export OTEL_SDK_DISABLED=false
export OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_TRACES_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=none
export OTEL_LOGS_EXPORTER=none
export ANTNEST_RUNTIME_OTEL_EXPORTER_OTLP_ENDPOINT="http://${ANTNEST_JAEGER_RUNTIME_IPV4}:4318"
export ANTNEST_BOOTSTRAP_ORGANIZATION_SLUG=stage2
export ANTNEST_BOOTSTRAP_ORGANIZATION_NAME="Stage 2"
export ANTNEST_BOOTSTRAP_ADMIN_EMAIL=stage2-admin@example.com
export ANTNEST_BOOTSTRAP_ADMIN_PASSWORD=stage2-admin-password

controller_url="http://127.0.0.1:${ANTNEST_AGENT_CONTROLLER_HOST_PORT}"
identity_url="http://127.0.0.1:${ANTNEST_IDENTITY_HOST_PORT}"
acp_url="ws://agent-acp-service:8080/v2/acp"
jaeger_url="http://jaeger:16686"
lifecycle_trace_id=4bf92f3577b34da6a3ce929d0e0e4736
execution_trace_id=5bf92f3577b34da6a3ce929d0e0e4736
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/antnest-stage2-e2e.XXXXXX")
agent_id=""

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then
    docker compose --profile stage2 --profile stage2-e2e --profile observability ps >&2 || true
    docker compose --profile stage2 --profile stage2-e2e --profile observability logs \
      --no-color --tail=200 identity-service agent-controller agent-acp-service \
      runtime-controller stage2-model jaeger \
      >&2 || true
    if [ -n "$agent_id" ]; then
      docker logs --tail=200 "antnest-runtime-${agent_id}" >&2 || true
    fi
  fi
  if [ -n "$agent_id" ]; then
    docker rm -f "antnest-runtime-${agent_id}" >/dev/null 2>&1 || true
    docker volume rm -f "antnest-workspace-${agent_id}" >/dev/null 2>&1 || true
  fi
  docker ps -aq \
    --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME" 2>/dev/null |
    while IFS= read -r runtime_container; do
      [ -z "$runtime_container" ] || docker rm -f "$runtime_container" >/dev/null 2>&1 || true
    done
  docker volume ls -q \
    --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME" 2>/dev/null |
    while IFS= read -r runtime_volume; do
      [ -z "$runtime_volume" ] || docker volume rm -f "$runtime_volume" >/dev/null 2>&1 || true
    done
  docker compose --profile stage2 --profile stage2-e2e --profile observability \
    down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "${temporary_root:?}"
  exit "$status"
}
trap cleanup EXIT INT TERM

request_json() {
  method=$1
  url=$2
  body_file=$3
  response_file=$4
  expected_status=$5
  trace_id=${6:-}
  trace_header=""
  if [ -n "$trace_id" ]; then
    trace_header="00-${trace_id}-0123456789abcdef-01"
  fi
  status=$(curl -sS -o "$response_file" -w '%{http_code}' \
    -X "$method" \
    -H 'accept: application/json' \
    -H 'content-type: application/json' \
    ${trace_header:+-H "traceparent: $trace_header"} \
    --data-binary "@$body_file" \
    "$url")
  if [ "$status" != "$expected_status" ]; then
    printf '%s %s returned HTTP %s, want %s: ' "$method" "$url" "$status" "$expected_status" >&2
    cat "$response_file" >&2
    printf '\n' >&2
    return 1
  fi
}

json_field() {
  node -e '
    const fs = require("node:fs");
    let value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const segment of process.argv[2].split(".")) value = value?.[segment];
    if (value === undefined) process.exit(2);
    process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
  ' "$1" "$2"
}

assert_json_field() {
  actual=$(json_field "$1" "$2")
  if [ "$actual" != "$3" ]; then
    printf '%s field %s = %s, want %s\n' "$1" "$2" "$actual" "$3" >&2
    return 1
  fi
}

docker compose --profile stage2 --profile stage2-e2e --profile observability up -d --wait \
  postgres stage2-model jaeger
docker compose --profile stage2 --profile stage2-e2e --profile observability up -d --wait \
  runtime-egress runtime-controller
docker compose --profile stage2 --profile stage2-e2e --profile observability up -d --wait \
  identity-service agent-controller
docker compose --profile stage2 --profile stage2-e2e --profile observability up -d --wait \
  agent-acp-service

runtime_image=$(docker image inspect --format '{{.Id}}' antnest/antnest-runtime:local)
if ! printf '%s' "$runtime_image" | grep -Eq '^sha256:[a-f0-9]{64}$'; then
  printf 'Runtime image is not immutable: %s\n' "$runtime_image" >&2
  exit 1
fi

cat >"$temporary_root/login.json" <<EOF
{
  "request_id": "stage2-login",
  "organization_slug": "stage2",
  "email": "stage2-admin@example.com",
  "password": "stage2-admin-password"
}
EOF
request_json POST "$identity_url/rpc/identity/local-login" \
  "$temporary_root/login.json" "$temporary_root/login-response.json" 200
organization_id=$(json_field "$temporary_root/login-response.json" principal.organization_id)
owner_user_id=$(json_field "$temporary_root/login-response.json" principal.user_id)
owner_membership_id=$(json_field "$temporary_root/login-response.json" principal.membership_id)

cat >"$temporary_root/model.json" <<EOF
{
  "request_id": "stage2-model",
  "organization_id": "$organization_id",
  "profile_key": "stage2-model",
  "display_name": "Stage 2 deterministic model",
  "model": {
    "base_url": "http://stage2-model:8080/v1",
    "model": "stage2-deterministic",
    "context_window": 8192,
    "max_output_tokens": 1024,
    "supports_images": false
  },
  "credential": { "secret_type": "bearer", "secret": "stage2-model-secret" }
}
EOF
request_json POST "$controller_url/internal/model-profiles" \
  "$temporary_root/model.json" "$temporary_root/model-response.json" 201
model_revision_id=$(json_field "$temporary_root/model-response.json" revision_id)

cat >"$temporary_root/template.json" <<EOF
{
  "request_id": "stage2-template",
  "organization_id": "$organization_id",
  "template_key": "stage2-template",
  "name": "Stage 2 Template",
  "model_profile_revision_id": "$model_revision_id",
  "system_prompt": "Use the available Runtime Tools to complete the request.",
  "max_model_requests": 4,
  "context_policy_version": "context-v1",
  "runtime": {
    "image_ref": "$runtime_image",
    "resources": {
      "memory_bytes": 536870912,
      "pids_limit": 256,
      "tmpfs_bytes": 67108864
    }
  }
}
EOF
request_json POST "$controller_url/internal/agent-templates" \
  "$temporary_root/template.json" "$temporary_root/template-response.json" 201
template_id=$(json_field "$temporary_root/template-response.json" template_id)
assert_json_field "$temporary_root/template-response.json" skill_refs '[]'

cat >"$temporary_root/agent.json" <<EOF
{
  "request_id": "stage2-agent-create",
  "organization_id": "$organization_id",
  "owner_user_id": "$owner_user_id",
  "name": "Stage 2 Agent",
  "template_id": "$template_id",
  "template_revision": 1
}
EOF
request_json POST "$controller_url/internal/agents" \
  "$temporary_root/agent.json" "$temporary_root/agent-response.json" 202 "$lifecycle_trace_id"
agent_id=$(json_field "$temporary_root/agent-response.json" agent.agent_id)
agent_access_subject=$(json_field "$temporary_root/agent-response.json" agent_access_subject)
assert_json_field "$temporary_root/agent-response.json" agent.lifecycle_state available
assert_json_field "$temporary_root/agent-response.json" operation.state completed

ANTNEST_STAGE2_ACP_URL="$acp_url" \
ANTNEST_STAGE2_AGENT_ACCESS_SUBJECT="$agent_access_subject" \
ANTNEST_STAGE2_TRACEPARENT="00-${execution_trace_id}-fedcba9876543210-01" \
ANTNEST_STAGE2_IDENTITY_URL="http://identity-service:8080" \
ANTNEST_STAGE2_ORGANIZATION_ID="$organization_id" \
ANTNEST_STAGE2_OWNER_USER_ID="$owner_user_id" \
ANTNEST_STAGE2_OWNER_MEMBERSHIP_ID="$owner_membership_id" \
  docker compose --profile stage2-e2e run --rm --no-deps \
  -e ANTNEST_STAGE2_ACP_URL \
  -e ANTNEST_STAGE2_AGENT_ACCESS_SUBJECT \
  -e ANTNEST_STAGE2_TRACEPARENT \
  -e ANTNEST_STAGE2_IDENTITY_URL \
  -e ANTNEST_STAGE2_ORGANIZATION_ID \
  -e ANTNEST_STAGE2_OWNER_USER_ID \
  -e ANTNEST_STAGE2_OWNER_MEMBERSHIP_ID \
  stage2-client node /app/scripts/stage2-acp-client.mjs \
  >"$temporary_root/acp-evidence.json"
assert_json_field "$temporary_root/acp-evidence.json" message \
  'Stage 2 Runtime Tool execution completed.'
assert_json_field "$temporary_root/acp-evidence.json" access_revalidation_code access_denied

workspace_evidence=$(docker exec "antnest-runtime-${agent_id}" \
  cat /workspace/stage2-evidence.txt)
if [ "$workspace_evidence" != "stage2-runtime-tool-ok" ]; then
  printf 'Runtime workspace evidence = %s\n' "$workspace_evidence" >&2
  exit 1
fi

docker compose --profile stage2-e2e run --rm --no-deps stage2-client \
  node /app/scripts/stage2-trace-assert.mjs "$jaeger_url" "$lifecycle_trace_id" lifecycle
docker compose --profile stage2-e2e run --rm --no-deps stage2-client \
  node /app/scripts/stage2-trace-assert.mjs "$jaeger_url" "$execution_trace_id" execution

request_json POST "$controller_url/internal/agents" \
  "$temporary_root/agent.json" "$temporary_root/agent-replay-response.json" 202
assert_json_field "$temporary_root/agent-replay-response.json" agent.agent_id "$agent_id"
assert_json_field "$temporary_root/agent-replay-response.json" operation.state completed

cat >"$temporary_root/rejected-agent.json" <<EOF
{
  "request_id": "stage2-agent-create-inactive-owner",
  "organization_id": "$organization_id",
  "owner_user_id": "$owner_user_id",
  "name": "Rejected Stage 2 Agent",
  "template_id": "$template_id",
  "template_revision": 1
}
EOF
request_json POST "$controller_url/internal/agents" \
	"$temporary_root/rejected-agent.json" "$temporary_root/rejected-agent-response.json" 404
assert_json_field "$temporary_root/rejected-agent-response.json" code reference_not_found

ANTNEST_STAGE2_ACP_URL="$acp_url" \
ANTNEST_STAGE2_AGENT_ACCESS_SUBJECT="$agent_access_subject" \
ANTNEST_STAGE2_EXPECTED_UPGRADE_STATUS=403 \
  docker compose --profile stage2-e2e run --rm --no-deps \
  -e ANTNEST_STAGE2_ACP_URL \
  -e ANTNEST_STAGE2_AGENT_ACCESS_SUBJECT \
  -e ANTNEST_STAGE2_EXPECTED_UPGRADE_STATUS \
  stage2-client node /app/scripts/stage2-acp-upgrade-status.mjs \
  >"$temporary_root/acp-rejection-evidence.json"
assert_json_field "$temporary_root/acp-rejection-evidence.json" upgrade_status 403

cat >"$temporary_root/delete.json" <<EOF
{"request_id":"stage2-agent-delete"}
EOF
request_json POST "$controller_url/internal/agents/${agent_id}/delete" \
  "$temporary_root/delete.json" "$temporary_root/delete-response.json" 202
assert_json_field "$temporary_root/delete-response.json" state completed
if docker inspect "antnest-runtime-${agent_id}" >/dev/null 2>&1; then
  echo "deleted Agent retained its Runtime container" >&2
  exit 1
fi
if docker volume inspect "antnest-workspace-${agent_id}" >/dev/null 2>&1; then
  echo "deleted Agent retained its workspace volume" >&2
  exit 1
fi

echo "Stage 2 Agent lifecycle, ACP Runtime Tool, and Jaeger E2E passed"
