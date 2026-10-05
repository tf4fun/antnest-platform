#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$repository_root"
. "$repository_root/tests/support/public-development-secrets.sh"
port_base=$((40000 + ($$ % 10000)))
network_octet=$((1 + ($$ % 200)))
export COMPOSE_PROJECT_NAME="antnest-stage2-e2e-$$"
node "$repository_root/tests/support/storage.mjs" "$repository_root/artifacts/verification/go-integration"
node "$repository_root/tests/support/storage.mjs" "$repository_root/artifacts/verification/stage2-boundary/$COMPOSE_PROJECT_NAME"
export COMPOSE_FILE="compose.yaml:compose.debug.yaml:tests/e2e/stage2.compose.yaml:tests/support/compose.public-development-secrets.yaml"
export COMPOSE_ENV_FILES=.env.example
export ANTNEST_POSTGRES_HOST_PORT=$port_base
export ANTNEST_RUNTIME_CONTROLLER_HOST_PORT=$((port_base + 1))
export ANTNEST_ACP_HOST_PORT=$((port_base + 2))
export ANTNEST_AGENT_CONTROLLER_HOST_PORT=$((port_base + 3))
export ANTNEST_JAEGER_UI_HOST_PORT=$((port_base + 4))
export ANTNEST_IDENTITY_HOST_PORT=$((port_base + 5))
export ANTNEST_STAGE2_MODEL_HOST_PORT=$((port_base + 6))
export ANTNEST_STAGE2_OTLP_HOST_PORT=$((port_base + 7))
export ANTNEST_TEMPORAL_HOST_PORT=$((port_base + 8))
export ANTNEST_EDGE_HOST_PORT=$((port_base + 9))
export ANTNEST_STAGE2_OTLP_URL="http://127.0.0.1:${ANTNEST_STAGE2_OTLP_HOST_PORT}/v1/traces"
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
export ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT=true

compose() { docker compose --profile stage2 --profile stage2-e2e --profile stage3 --profile observability "$@"; }
cleanup() {
  status=$?
  trap - EXIT INT TERM
  set +e
  cleanup_status=0
  if [ "$status" -ne 0 ]; then
    compose ps >&2 || true
    compose logs --no-color --tail=60 agent-controller agent-acp-service runtime-controller >&2 || true
  fi
  containers=$(docker ps -aq --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME") || cleanup_status=1
  for id in $containers; do docker rm -f "$id" >/dev/null || cleanup_status=1; done
  volumes=$(docker volume ls -q --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME") || cleanup_status=1
  for id in $volumes; do docker volume rm -f "$id" >/dev/null || cleanup_status=1; done
  compose down --volumes --remove-orphans >/dev/null 2>&1 || cleanup_status=1
  remaining_containers=$(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") || cleanup_status=1
  remaining_volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME") || cleanup_status=1
  test -z "$remaining_containers$remaining_volumes" || cleanup_status=1
  if [ "$cleanup_status" -ne 0 ]; then
    printf 'Stage 2 cleanup failed for %s\n' "$COMPOSE_PROJECT_NAME" >&2
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export ANTNEST_STAGE2_RUNTIME_IMAGE
ANTNEST_STAGE2_RUNTIME_IMAGE=$(docker image inspect --format '{{.Id}}' antnest/antnest-runtime:local)
compose config --format json | node tests/support/verification/execution-deployment.mjs
compose up -d --wait postgres stage2-model jaeger
# Reserve fixed management addresses before starting dynamically addressed peers.
compose up -d --wait runtime-egress
compose up -d --wait runtime-controller identity-service agent-acp-service
compose up -d --wait agent-controller
compose up -d --no-deps --wait admin-console edge-gateway
# Worker recovery uses an isolated database on this fixture's PostgreSQL instance.
compose exec -T postgres createdb -U antnest_test_admin -O antnest_agent_controller stage2_workflow_test
ANTNEST_TEMPORAL_TEST_ADDRESS="127.0.0.1:$ANTNEST_TEMPORAL_HOST_PORT" \
ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL="postgres://antnest_agent_controller:${ANTNEST_AGENT_CONTROLLER_POSTGRES_PASSWORD:-antnest-agent-controller-dev}@127.0.0.1:$ANTNEST_POSTGRES_HOST_PORT/stage2_workflow_test" \
GOCACHE="$repository_root/.cache/go-build" GOMODCACHE="$repository_root/.cache/go-mod" \
node tests/integration/go/run.mjs agent-controller -- -timeout=5m \
  -run '^TestTemporal(CreationSurvivesWorkerReplacement|LifecycleWorkerReplacement|ResumesAfterBusinessCommitBeforeActivityAcknowledgement)$' -v
compose exec -T postgres dropdb -U antnest_test_admin stage2_workflow_test
compose exec -T postgres createdb -U antnest_test_admin -O antnest_agent_acp stage2_acp_test
ANTNEST_ACP_TEST_DATABASE_URL="postgres://antnest_agent_acp:${ANTNEST_AGENT_ACP_POSTGRES_PASSWORD:-antnest-agent-acp-dev}@127.0.0.1:$ANTNEST_POSTGRES_HOST_PORT/stage2_acp_test" \
npm --prefix services/agent-acp-service run test:postgres
compose exec -T postgres dropdb -U antnest_test_admin stage2_acp_test
node tests/e2e/agent-acp-service/stage2-boundary-flow.mjs
