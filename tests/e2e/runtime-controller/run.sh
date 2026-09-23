#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../../../" && pwd)
cd "$repository_root"

export COMPOSE_PROJECT_NAME="antnest-runtime-controller-e2e-$$"
export ANTNEST_POSTGRES_HOST_PORT=$((30000 + ($$ % 5000)))
export ANTNEST_RUNTIME_CONTROLLER_HOST_PORT=$((40000 + ($$ % 5000)))
export ANTNEST_RUNTIME_MANAGEMENT_NETWORK="${COMPOSE_PROJECT_NAME}-runtime-management"
export ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME="${COMPOSE_PROJECT_NAME}-system-skills"
network_octet=$((1 + ($$ % 200)))
export ANTNEST_RUNTIME_MANAGEMENT_SUBNET="10.253.${network_octet}.0/24"
export ANTNEST_EGRESS_IPV4="10.253.${network_octet}.3"
export ANTNEST_EGRESS_CONTROL_SUBNET="10.252.${network_octet}.0/24"
export ANTNEST_EGRESS_CONTROL_IPV4="10.252.${network_octet}.3"

agent_id="agent-runtime-controller-e2e-$$"
runtime_name="antnest-runtime-${agent_id}"
workspace_volume="antnest-workspace-${agent_id}"
controller_url="http://127.0.0.1:${ANTNEST_RUNTIME_CONTROLLER_HOST_PORT}"
egress_url="http://${ANTNEST_EGRESS_CONTROL_IPV4}:8081"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then
    docker compose ps >&2 || true
    docker compose logs --no-color --tail=200 runtime-controller runtime-egress >&2 || true
    docker inspect "$runtime_name" >&2 || true
    docker logs --tail=200 "$runtime_name" >&2 || true
  fi
  docker rm -f "$runtime_name" >/dev/null 2>&1 || true
  docker volume rm "$workspace_volume" >/dev/null 2>&1 || true
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT INT TERM

egress_request() {
  docker compose exec -T runtime-egress curl --fail-with-body -sS "$@"
}

controller_request() {
  curl --fail-with-body -sS "$@"
}

wait_for_controller() {
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    if controller_request "$controller_url/status" 2>/dev/null | grep -q '"status":"ready"'; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  echo "Runtime Controller did not become ready" >&2
  return 1
}

docker compose up -d --wait postgres runtime-egress runtime-controller

runtime_image=$(docker image inspect --format '{{.Id}}' antnest/antnest-runtime:local)
case "$runtime_image" in
  sha256:*) ;;
  *) echo "Runtime image did not resolve to an immutable sha256 ID" >&2; exit 1 ;;
esac
if [ "${#runtime_image}" -ne 71 ]; then
  echo "Runtime image ID has an invalid sha256 length" >&2
  exit 1
fi

egress_request "$egress_url/status" | grep -q '"status":"ready"'
egress_request -X PUT "$egress_url/internal/agent-networks/${agent_id}" | grep -q '"tunnel_ipv4":"100.64.0.2"'
egress_request -X PUT -H 'content-type: application/json' \
  -d '{"spec":{"schema_version":1,"action":"allow_all"}}' \
  "$egress_url/internal/policies/runtime-controller-e2e/revisions/1" >/dev/null
egress_request -X PUT -H 'content-type: application/json' \
  -d '{"policy_id":"runtime-controller-e2e","revision":1,"expected_resource_version":1}' \
  "$egress_url/internal/agent-policy-assignments/${agent_id}" >/dev/null

wait_for_controller
runtime_configuration=$(printf '%s' "{\"image_ref\":\"${runtime_image}\",\"network\":{\"packet_contract_revision\":1,\"egress_endpoint\":{\"ipv4\":\"${ANTNEST_EGRESS_IPV4}\",\"port\":8092},\"tunnel_ipv4\":\"100.64.0.2\",\"resolver_ipv4\":\"100.64.0.1\"},\"resources\":{\"memory_bytes\":536870912,\"pids_limit\":256,\"tmpfs_bytes\":67108864}}")
initialize_payload=$(printf '%s' "{\"configuration\":${runtime_configuration}}")
created=$(controller_request -X POST -H 'content-type: application/json' \
  -H "Idempotency-Key: initialize-${agent_id}" -d "$initialize_payload" \
  "$controller_url/internal/runtimes/${agent_id}/initialize")
printf '%s' "$created" | grep -q '"state":"completed"'
printf '%s' "$created" | grep -q '"lifecycle_state":"provisioned"'
if printf '%s' "$created" | grep -q '"runtime_execution_id":'; then
  echo "Creation incorrectly asserted an execution identity" >&2
  exit 1
fi
# Readiness is a separate observation, not part of the creation response.
attempt=0
first_execution=""
while [ "$attempt" -lt 60 ]; do
  inspection=$(controller_request "$controller_url/internal/runtimes/${agent_id}")
  first_execution=$(printf '%s' "$inspection" | sed -n 's/.*"runtime_execution_id":"\([^"]*\)".*/\1/p')
  if [ -n "$first_execution" ]; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
runtime_revision=$(printf '%s' "$created" | sed -n 's/.*"target_revision":"\([^"]*\)".*/\1/p')
test -n "$first_execution"
test -n "$runtime_revision"

controller_request "$controller_url/internal/runtimes/${agent_id}" \
  | grep -q "\"runtime_execution_id\":\"${first_execution}\""
controller_request "$controller_url/internal/runtime-operations/initialize-${agent_id}" \
  | grep -q "\"target_revision\":\"${runtime_revision}\""

before_restart=$(controller_request "$controller_url/internal/runtime-observations?after_sequence=0&limit=500")
before_restart_sequence=$(printf '%s' "$before_restart" | sed -n 's/.*"latest_sequence":\([0-9][0-9]*\).*/\1/p')
test -n "$before_restart_sequence"
docker compose restart runtime-controller >/dev/null
wait_for_controller
controller_request "$controller_url/internal/runtimes/${agent_id}" \
  | grep -q "\"runtime_revision\":\"${runtime_revision}\""
controller_request "$controller_url/internal/runtime-operations/initialize-${agent_id}" \
  | grep -q '"state":"completed"'
after_restart=$(controller_request "$controller_url/internal/runtime-observations?after_sequence=0&limit=500")
after_restart_sequence=$(printf '%s' "$after_restart" | sed -n 's/.*"latest_sequence":\([0-9][0-9]*\).*/\1/p')
if [ -z "$after_restart_sequence" ] || [ "$after_restart_sequence" -lt "$before_restart_sequence" ]; then
  echo "Runtime observation journal regressed across Controller restart" >&2
  exit 1
fi

docker restart "$runtime_name" >/dev/null
attempt=0
second_execution=""
while [ "$attempt" -lt 30 ]; do
  observations=$(controller_request "$controller_url/internal/runtime-observations?after_sequence=0&limit=500")
  printf '%s' "$observations" | grep -q '"oldest_sequence":'
  printf '%s' "$observations" | grep -q '"latest_sequence":'
  printf '%s' "$observations" | grep -q '"next_sequence":'
  second_execution=$(printf '%s' "$observations" | sed -n 's/.*"runtime_execution_id":"\([^"]*\)".*"kind":"healthy".*/\1/p')
  if [ -n "$second_execution" ] && [ "$second_execution" != "$first_execution" ]; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ -z "$second_execution" ] || [ "$second_execution" = "$first_execution" ]; then
  echo "Runtime restart did not produce a new execution observation" >&2
  exit 1
fi
stale_status=$(docker exec "$runtime_name" curl -sS -o /dev/null -w '%{http_code}' \
  -X POST -H 'content-type: application/json' \
  -H "X-Antnest-Expected-Execution-ID: ${first_execution}" \
  -d '{}' http://127.0.0.1:8093/mcp)
if [ "$stale_status" != "409" ]; then
  echo "stale Runtime execution fence returned HTTP ${stale_status}" >&2
  exit 1
fi

update_payload=$(printf '%s' "{\"expected_revision\":\"${runtime_revision}\",\"configuration\":${runtime_configuration}}")
updated=$(controller_request -X POST -H 'content-type: application/json' \
  -H "Idempotency-Key: update-${agent_id}" -d "$update_payload" \
  "$controller_url/internal/runtimes/${agent_id}/update")
printf '%s' "$updated" | grep -q '"state":"completed"'
runtime_revision=$(printf '%s' "$updated" | sed -n 's/.*"target_revision":"\([^"]*\)".*/\1/p')
test -n "$runtime_revision"

revision_payload=$(printf '%s' "{\"expected_revision\":\"${runtime_revision}\"}")
disabled=$(controller_request -X POST -H 'content-type: application/json' \
  -H "Idempotency-Key: disable-${agent_id}" -d "$revision_payload" \
  "$controller_url/internal/runtimes/${agent_id}/disable")
printf '%s' "$disabled" | grep -q '"lifecycle_state":"disabled"'
if docker inspect "$runtime_name" >/dev/null 2>&1; then
  echo "Runtime compute survived Disable" >&2
  exit 1
fi
docker volume inspect "$workspace_volume" >/dev/null
runtime_revision=$(printf '%s' "$disabled" | sed -n 's/.*"target_revision":"\([^"]*\)".*/\1/p')
enable_payload=$(printf '%s' "{\"expected_revision\":\"${runtime_revision}\",\"configuration\":${runtime_configuration}}")
enabled=$(controller_request -X POST -H 'content-type: application/json' \
  -H "Idempotency-Key: enable-${agent_id}" -d "$enable_payload" \
  "$controller_url/internal/runtimes/${agent_id}/enable")
printf '%s' "$enabled" | grep -q '"lifecycle_state":"provisioned"'
runtime_revision=$(printf '%s' "$enabled" | sed -n 's/.*"target_revision":"\([^"]*\)".*/\1/p')
test -n "$runtime_revision"

revision_payload=$(printf '%s' "{\"expected_revision\":\"${runtime_revision}\"}")
controller_request -X POST -H 'content-type: application/json' \
  -H "Idempotency-Key: delete-${agent_id}" -d "$revision_payload" \
  "$controller_url/internal/runtimes/${agent_id}/delete" | grep -q '"lifecycle_state":"deleted"'
controller_request "$controller_url/internal/runtimes/${agent_id}" | grep -q '"lifecycle_state":"deleted"'
if controller_request "$controller_url/internal/runtimes" | grep -q "\"agent_id\":\"${agent_id}\""; then
  echo "Deleted Runtime remained in active inventory" >&2
  exit 1
fi
if docker volume inspect "$workspace_volume" >/dev/null 2>&1; then
  echo "Agent workspace survived Runtime deletion" >&2
  exit 1
fi

echo "Runtime Controller Docker E2E passed"
