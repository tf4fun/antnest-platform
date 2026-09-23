#!/bin/sh
set -eu

keep_stack=${ANTNEST_E2E_KEEP_STACK:-false}
case "$keep_stack" in
  false) ;;
  true)
    echo 'ANTNEST_E2E_KEEP_STACK=true is retired; use make e2e-stage3-local or make e2e-workspace-browser for disposable acceptance.' >&2
    exit 1 ;;
  *) echo 'ANTNEST_E2E_KEEP_STACK must be false or unset' >&2; exit 1 ;;
esac

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repository_root"

# Validate persistent diagnostic output before network allocation touches Docker.
identity_diagnostic_log=${ANTNEST_E2E_IDENTITY_DIAGNOSTIC_LOG:-}
if [ -n "$identity_diagnostic_log" ]; then
  identity_diagnostic_log=$(node --input-type=module - "$identity_diagnostic_log" <<'NODE'
import assert from 'node:assert/strict';
import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { durablePath } from './tests/support/storage.mjs';
const path = durablePath(process.argv[2]);
assert(!existsSync(path) || statSync(path).isFile(), 'diagnostic output must be a regular file');
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const descriptor = openSync(path, 'w', 0o600);
try { fchmodSync(descriptor, 0o600); } finally { closeSync(descriptor); }
process.stdout.write(path);
NODE
  )
fi

port_base=$((42000 + ($$ % 8000)))
export COMPOSE_PROJECT_NAME="antnest-stage3-e2e-$$"
node tests/support/verification/stage3-storage.mjs "$COMPOSE_PROJECT_NAME"
network_octet=$(node tests/e2e/acp-closeout/network.mjs "$((1 + ($$ % 200)))")
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
identity_access=${ANTNEST_E2E_IDENTITY_ACCESS:-false}
identity_core=${ANTNEST_E2E_IDENTITY_CORE:-false}
acp_session=${ANTNEST_E2E_ACP_SESSION:-false}
agent_access=${ANTNEST_E2E_AGENT_ACCESS:-false}
tool_progress=${ANTNEST_E2E_TOOL_PROGRESS:-false}
if [ "$tool_progress" = true ]; then
  export ANTNEST_PROGRESS_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_PROGRESS_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
fi
file_observations=${ANTNEST_E2E_FILE_OBSERVATIONS:-false}
if [ "$file_observations" = true ]; then
  export ANTNEST_FILES_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_FILES_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
fi
structured_plan=${ANTNEST_E2E_STRUCTURED_PLAN:-false}
if [ "$structured_plan" = true ]; then
  export ANTNEST_PLAN_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_PLAN_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
fi
slash_commands=${ANTNEST_E2E_SLASH_COMMANDS:-false}
if [ "$slash_commands" = true ]; then
  export ANTNEST_COMMANDS_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_COMMANDS_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
fi
multimodal=${ANTNEST_E2E_MULTIMODAL:-false}
if [ "$multimodal" = true ]; then
  export ANTNEST_MULTIMODAL_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_MULTIMODAL_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
fi
session_cost=${ANTNEST_E2E_SESSION_COST:-false}
if [ "$session_cost" = true ]; then
  export ANTNEST_COST_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_COST_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
fi
rpc_response_loss=${ANTNEST_E2E_RPC_RESPONSE_LOSS:-false}
case "$rpc_response_loss" in
  true|false) ;;
  *) echo 'ANTNEST_E2E_RPC_RESPONSE_LOSS must be true or false' >&2; exit 1 ;;
esac
if [ "$rpc_response_loss" = true ]; then
  export ANTNEST_RPC_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_RPC_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
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
tool_permissions=${ANTNEST_E2E_TOOL_PERMISSIONS:-false}
case "$tool_permissions" in
  true|false) ;;
  *) echo "ANTNEST_E2E_TOOL_PERMISSIONS must be true or false" >&2; exit 1 ;;
esac
if [ "$tool_permissions" = true ]; then
  for incompatible in "$session_cost" "$multimodal" "$slash_commands" "$structured_plan" "$file_observations" "$tool_progress" "$rpc_response_loss" "$keep_stack" "$agent_access" "$identity_access" "$acp_session" "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" "${ANTNEST_E2E_MANAGED_MCP:-false}"; do
    [ "$incompatible" = false ] || { echo 'Tool permissions require a separate disposable profile' >&2; exit 1; }
  done
  export ANTNEST_PERMISSIONS_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_PERMISSIONS_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
fi
acp_persistence=${ANTNEST_E2E_ACP_PERSISTENCE:-false}
case "$acp_persistence" in true|false) ;; *) echo 'Invalid persistence profile' >&2; exit 1 ;; esac
if [ "$acp_persistence" = true ]; then
  for incompatible in "$tool_permissions" "$session_cost" "$multimodal" "$slash_commands" "$structured_plan" "$file_observations" "$tool_progress" "$rpc_response_loss" "$keep_stack" "$agent_access" "$identity_access" "$acp_session" "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" "${ANTNEST_E2E_MANAGED_MCP:-false}"; do
    [ "$incompatible" = false ] || { echo 'Persistence requires a separate disposable profile' >&2; exit 1; }
  done
  export ANTNEST_PERSISTENCE_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_PERSISTENCE_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
fi
acp_restart=${ANTNEST_E2E_ACP_RESTART:-false}
case "$acp_restart" in true|false) ;; *) echo 'Invalid restart profile' >&2; exit 1 ;; esac
if [ "$acp_restart" = true ]; then
  for incompatible in "$acp_persistence" "$tool_permissions" "$session_cost" "$multimodal" "$slash_commands" "$structured_plan" "$file_observations" "$tool_progress" "$rpc_response_loss" "$keep_stack" "$agent_access" "$identity_access" "$acp_session" "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" "${ANTNEST_E2E_MANAGED_MCP:-false}"; do
    [ "$incompatible" = false ] || { echo 'Restart requires a separate disposable profile' >&2; exit 1; }
  done
  export ANTNEST_RESTART_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_RESTART_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
fi
tool_profile=""
[ "$tool_permissions" != true ] || tool_profile=tool-permissions
[ "$tool_progress" != true ] || tool_profile=tool-progress
[ "$file_observations" != true ] || tool_profile=file-observations
[ "$structured_plan" != true ] || tool_profile=structured-plan
[ "$slash_commands" != true ] || tool_profile=slash-commands
[ "$multimodal" != true ] || tool_profile=multimodal
[ "$session_cost" != true ] || tool_profile=session-cost
[ "$rpc_response_loss" != true ] || tool_profile=rpc-response-loss
[ "$acp_persistence" != true ] || tool_profile=acp-persistence
[ "$acp_restart" != true ] || tool_profile=acp-restart
managed_mcp=${ANTNEST_E2E_MANAGED_MCP:-false}
case "$managed_mcp" in
  true|false) ;;
  *) echo 'ANTNEST_E2E_MANAGED_MCP must be true or false' >&2; exit 1 ;;
esac
if [ "$managed_mcp" = true ]; then
  [ -z "$tool_profile" ] || { echo 'Managed MCP requires a separate disposable profile' >&2; exit 1; }
  for incompatible in "$keep_stack" "$agent_access" "$identity_access" "$acp_session" "${ANTNEST_E2E_ACP_CLOSEOUT:-false}"; do
    [ "$incompatible" = false ] || { echo 'Managed MCP requires a separate disposable profile' >&2; exit 1; }
  done
  case "${ANTNEST_E2E_MANAGED_MCP_VERSION:-1}" in
    1|2) ;;
    *) echo 'Managed MCP version must be 1 or 2' >&2; exit 1 ;;
  esac
  tool_profile=managed-mcp
  export ANTNEST_MANAGED_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_MANAGED_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
fi
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
case "$identity_core" in true|false) ;; *) echo 'Invalid Identity core profile' >&2; exit 1 ;; esac
if [ "$identity_core" = true ]; then
  [ -z "$tool_profile" ] || { echo 'Identity core requires a separate disposable profile' >&2; exit 1; }
  for incompatible in "$identity_access" "$agent_access" "$acp_session" "$keep_stack" "${ANTNEST_E2E_ACP_CLOSEOUT:-false}"; do
    [ "$incompatible" = false ] || { echo 'Identity core requires a separate disposable profile' >&2; exit 1; }
  done
fi
if [ "$identity_core" = true ] || [ "$identity_access" = true ]; then
  tool_profile=identity-http
  export ANTNEST_IDENTITY_SUITE=access
  [ "$identity_core" = false ] || export ANTNEST_IDENTITY_SUITE=core
  export ANTNEST_IDENTITY_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_IDENTITY_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
fi
if [ "$agent_access" = true ] || [ "$acp_session" = true ]; then
  tool_profile=acp-session
  [ "$agent_access" = false ] || tool_profile=agent-access
  export ANTNEST_IDENTITY_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_IDENTITY_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
fi
case "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" in true|false) ;; *) echo 'Invalid ACP closeout profile' >&2; exit 1 ;; esac
if [ "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" = true ]; then
  [ -z "$tool_profile" ] && [ "$keep_stack" = false ] || { echo 'ACP closeout requires a separate disposable profile' >&2; exit 1; }
  tool_profile=acp-closeout
  export ANTNEST_IDENTITY_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_IDENTITY_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
fi
base_profile=false
if [ -z "$tool_profile" ] && [ "$keep_stack" = false ] && [ "$identity_access" = false ] && [ "$acp_session" = false ] && [ "$agent_access" = false ] && [ "${ANTNEST_E2E_ACP_CLOSEOUT:-false}" = false ] && [ "${ANTNEST_E2E_MANAGED_MCP:-false}" = false ]; then
  base_profile=true
  tool_profile=stage3-base
  export ANTNEST_BASE_CONTROL_DYNAMIC_RANGE="10.242.${network_octet}.128/25"
  export ANTNEST_BASE_RUNTIME_DYNAMIC_RANGE="10.243.${network_octet}.128/25"
  export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=false
fi
if [ -n "$tool_profile" ]; then
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
  docker() { node "$repository_root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
fi
runtime_image=$(docker image inspect --format '{{.Id}}' antnest/antnest-runtime:local)
if ! printf '%s' "$runtime_image" | grep -Eq '^sha256:[a-f0-9]{64}$'; then
  printf 'Runtime image is not immutable: %s\n' "$runtime_image" >&2
  exit 1
fi
export ANTNEST_ADMIN_DEFAULT_RUNTIME_IMAGE_REF=$runtime_image

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/antnest-stage3-e2e.XXXXXX")

compose() {
  if [ "$tool_profile" = identity-http ] || [ "$tool_profile" = acp-session ] || [ "$tool_profile" = agent-access ] || [ "$tool_profile" = acp-closeout ]; then
    if [ "$1" = up ]; then identity_lifecycle=--lifecycle; else identity_lifecycle=; fi
    docker $identity_lifecycle compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml \
      -f tests/e2e/identity-closeout/oidc-compose.yaml -f tests/e2e/identity-closeout/compose.yaml \
      --profile stage3 --profile observability "$@"
    return
  fi
  if [ "$managed_mcp" = true ]; then
    if [ "$1" = up ]; then
      docker --lifecycle compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/managed-mcp/compose.yaml --profile stage3 --profile observability "$@"
    else
      docker compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/managed-mcp/compose.yaml --profile stage3 --profile observability "$@"
    fi
    return
  fi
  if [ "$base_profile" = true ]; then
    if [ "$1" = up ]; then
      docker --lifecycle compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/stage3-base/compose.yaml --profile stage3 --profile observability "$@"
    else
      docker compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/stage3-base/compose.yaml --profile stage3 --profile observability "$@"
    fi
    return
  fi
  if [ "$session_cost" = true ]; then
    if [ "$1" = up ]; then
      docker --lifecycle compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-cost/compose.yaml --profile stage3 --profile observability "$@"
    else
      docker compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-cost/compose.yaml --profile stage3 --profile observability "$@"
    fi
    return
  fi
  if [ "$multimodal" = true ]; then
    if [ "$1" = up ]; then
      docker --lifecycle compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-multimodal/compose.yaml --profile stage3 --profile observability "$@"
    else
      docker compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-multimodal/compose.yaml --profile stage3 --profile observability "$@"
    fi
    return
  fi
  if [ "$tool_permissions" = true ]; then
    if [ "$1" = up ]; then
      docker --lifecycle compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-permissions/compose.yaml --profile stage3 --profile observability "$@"
    else
      docker compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-permissions/compose.yaml --profile stage3 --profile observability "$@"
    fi
    return
  fi
  if [ "$slash_commands" = true ]; then
    if [ "$1" = up ]; then
      docker --lifecycle compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-commands/compose.yaml --profile stage3 --profile observability "$@"
    else
      docker compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-commands/compose.yaml --profile stage3 --profile observability "$@"
    fi
    return
  fi
  if [ "$structured_plan" = true ]; then
    if [ "$1" = up ]; then
      docker --lifecycle compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-plan/compose.yaml --profile stage3 --profile observability "$@"
    else
      docker compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-plan/compose.yaml --profile stage3 --profile observability "$@"
    fi
    return
  fi
  if [ "$file_observations" = true ]; then
    if [ "$1" = up ]; then
      docker --lifecycle compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-files/compose.yaml --profile stage3 --profile observability "$@"
    else
      docker compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-files/compose.yaml --profile stage3 --profile observability "$@"
    fi
    return
  fi
  if [ "$tool_progress" = true ]; then
    if [ "$1" = up ]; then
      docker --lifecycle compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-progress/compose.yaml --profile stage3 --profile observability "$@"
    else
      docker compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-progress/compose.yaml --profile stage3 --profile observability "$@"
    fi
    return
  fi
  if [ "$acp_restart" = true ]; then
    if [ "$1" = up ]; then
      docker --lifecycle compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-restart/compose.yaml --profile stage3 --profile observability "$@"
    else
      docker compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-restart/compose.yaml --profile stage3 --profile observability "$@"
    fi
    return
  fi
  if [ "$acp_persistence" = true ]; then
    if [ "$1" = up ]; then
      docker --lifecycle compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-persistence/compose.yaml --profile stage3 --profile observability "$@"
    else
      docker compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/acp-persistence/compose.yaml --profile stage3 --profile observability "$@"
    fi
    return
  fi
  if [ "$rpc_response_loss" = true ]; then
    if [ "$1" = up ]; then
      docker --lifecycle compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/rpc-response-loss/compose.yaml --profile stage3 --profile observability "$@"
    else
      docker compose --env-file /dev/null -f compose.yaml -f compose.stage3.yaml -f tests/e2e/rpc-response-loss/compose.yaml --profile stage3 --profile observability "$@"
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
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$tool_profile" ]; then
    export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+120000))')
  fi
  if [ -n "${identity_diagnostic_log:-}" ]; then
    (
      umask 077
      node tests/support/storage.mjs "$identity_diagnostic_log" &&
        compose logs --no-color identity-service admin-console edge-gateway \
          > "$identity_diagnostic_log" 2>&1
    ) || true
  fi
  if [ "$status" -ne 0 ]; then
    compose ps >&2 || true
    compose logs --no-color --tail=200 edge-gateway admin-console agent-ui agent-acp-service \
      identity-service agent-controller runtime-controller runtime-egress stage3-model jaeger \
      > "$temporary_root/failure-logs.txt" 2>/dev/null || true
    node tests/e2e/identity-closeout/check-oidc-logs.mjs --summary "$temporary_root/failure-logs.txt" >&2 || true
    printf 'Raw service and runtime logs omitted: they may contain credentials.\n' >&2
  fi
  # Stop asynchronous creators before enumerating their Docker resources.
  compose stop agent-controller runtime-controller >/dev/null 2>&1 || status=1
  if [ -n "$tool_profile" ]; then
    docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" |
      while IFS= read -r owned_container; do
        [ -z "$owned_container" ] || docker rm -f -v "$owned_container" >/dev/null 2>&1 || true
      done
  fi
  docker ps -aq --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME" 2>/dev/null |
    while IFS= read -r runtime_container; do
      [ -z "$runtime_container" ] || docker rm -f -v "$runtime_container" >/dev/null 2>&1 || true
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
  rm -rf -- "${temporary_root:?}"
  if [ -n "$tool_profile" ] && [ "$status" -eq 0 ]; then
    if [ "$tool_profile" = managed-mcp ]; then
      echo "ACP v${ANTNEST_E2E_MANAGED_MCP_VERSION:-1} deployed $tool_profile E2E passed; owned resources removed"
    else
      echo "ACP v1/v2 deployed $tool_profile E2E passed; owned resources removed"
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

prepare_oidc() {
  mkdir "$temporary_root/certs"
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=oidc-fixture \
    -addext 'subjectAltName=DNS:oidc-fixture' \
    -keyout "$temporary_root/certs/tls.key" -out "$temporary_root/certs/tls.crt" >/dev/null 2>&1
  # The nonroot Identity service reads the public CA from the fixture volume.
  # Keep the private key at OpenSSL's restrictive mode, regardless of umask.
  chmod 644 "$temporary_root/certs/tls.crt"
  compose create oidc-fixture
  docker run --rm --network none --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --mount "type=bind,source=$temporary_root/certs,target=/input,readonly" \
    --mount "type=volume,source=${COMPOSE_PROJECT_NAME}-oidc-certs,target=/certs" \
    debian:bookworm-slim cp /input/tls.key /input/tls.crt /certs/
}

if [ -n "$tool_profile" ]; then
  if [ "$tool_profile" = identity-http ] || [ "$tool_profile" = acp-session ] || [ "$tool_profile" = agent-access ] || [ "$tool_profile" = acp-closeout ]; then prepare_oidc; fi
  compose up -d --wait
  ANTNEST_E2E_DISPOSABLE=true sh "tests/e2e/e2e-${tool_profile}.sh"
  exit 0
fi
