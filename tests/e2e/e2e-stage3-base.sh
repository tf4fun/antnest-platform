#!/bin/sh
set -eu
[ "${ANTNEST_E2E_DISPOSABLE:-false}" = true ] || { echo 'Use make e2e-stage3-local' >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
. "$root/tests/support/service-hosts.sh"
evidence="$root/artifacts/verification/stage3-base/$COMPOSE_PROJECT_NAME"
node "$root/tests/support/storage.mjs" "$evidence"
export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+900000))')
docker_cmd() { node "$root/tests/e2e/acp-closeout/docker.mjs" "$@"; }
model="${COMPOSE_PROJECT_NAME}-base-model"
client="${COMPOSE_PROJECT_NAME}-base-client"
legacy_helper="${COMPOSE_PROJECT_NAME}-legacy-inventory-helper"
fault_proxy="${COMPOSE_PROJECT_NAME}-rc-fault-proxy"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/antnest-stage3-base.XXXXXX")
cleanup() {
  status=$?
  trap - EXIT INT TERM
  export ANTNEST_E2E_DEADLINE_MS=$(node -e 'process.stdout.write(String(Date.now()+60000))')
  if [ "${ANTNEST_E2E_SKILL_MOUNT_RACE:-false}" = true ] || [ "${ANTNEST_E2E_SKILL_INITIALIZE_RACE:-false}" = true ]; then
    race_proxy=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter 'label=com.docker.compose.service=skill-docker-proxy')
    if [ -n "$race_proxy" ] && docker_cmd cp "$race_proxy:/proxy/race.json" "$temporary/race.json" >/dev/null 2>&1; then
      node "$root/tests/e2e/stage3-base/skill-mount-race-cleanup.mjs" "$temporary/race.json" "$COMPOSE_PROJECT_NAME" || status=1
    fi
  fi
  docker_cmd rm -f "$client" "$model" >/dev/null 2>&1 || status=1
  if [ "${ANTNEST_E2E_SKILL_FENCED_INVALIDATION:-false}" = true ] || [ "${ANTNEST_E2E_SKILL_RESTART_REBUILD:-false}" = true ]; then
    docker_cmd rm -f "$fault_proxy" >/dev/null 2>&1 || status=1
  fi
  if [ -n "${legacy_helper_id:-}" ]; then
    docker_cmd rm -f "$legacy_helper" >/dev/null 2>&1 || status=1
  fi
  rm -rf "$temporary"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
containers=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
# IDs originate from Docker and contain no shell metacharacters.
docker_cmd inspect $containers >"$temporary/deployment.json"
node "$root/tests/e2e/stage3-base/deployment.mjs" "$temporary/deployment.json" "$COMPOSE_PROJECT_NAME"
if [ "${ANTNEST_E2E_SKILL_FENCED_INVALIDATION:-false}" = true ] || [ "${ANTNEST_E2E_SKILL_RESTART_REBUILD:-false}" = true ]; then
  docker_cmd run -d --name "$fault_proxy" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --network "${COMPOSE_PROJECT_NAME}_controller-runtime" --network-alias stage3-rc-proxy \
    -e "ANTNEST_E2E_SKILL_RESTART_REBUILD=${ANTNEST_E2E_SKILL_RESTART_REBUILD:-false}" \
    -v "$root/tests:/app/tests:ro" \
    antnest/agent-acp-service:local node /app/tests/e2e/stage3-base/rc-fault-proxy.mjs >/dev/null
fi
image=antnest/antnest-runtime:local
docker_cmd image inspect "$image" >/dev/null
registry_ip=
if [ "${ANTNEST_E2E_SKILL_DELIVERY:-false}" = true ]; then
  registry_container=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter 'label=com.docker.compose.service=skill-registry')
  [ -n "$registry_container" ] || { echo 'Skill Registry container missing' >&2; exit 1; }
  docker_cmd inspect "$registry_container" > "$temporary/registry.json"
  docker_cmd network inspect "${COMPOSE_PROJECT_NAME}_registry-clients" > "$temporary/registry-network.json"
  registry_ip=$(node "$root/tests/e2e/stage3-base/registry-network.mjs" "$temporary/registry.json" "$temporary/registry-network.json" "$COMPOSE_PROJECT_NAME")
fi
legacy_helper_id=
if [ "${ANTNEST_E2E_LEGACY_INVENTORY:-false}" = true ]; then
  printf '%s' 'Legacy shared Skill volume content awaiting explicit migration.' > "$temporary/legacy-note.txt"
  legacy_helper_id=$(docker_cmd create --name "$legacy_helper" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --network none -v "$ANTNEST_RUNTIME_SYSTEM_SKILLS_VOLUME:/legacy" antnest/agent-acp-service:local)
  docker_cmd cp "$temporary/legacy-note.txt" "$legacy_helper:/legacy/legacy-note.txt"
fi
docker_cmd run -d --name "$model" --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "name=${COMPOSE_PROJECT_NAME}_acp-provider,alias=stage3-model-peer" \
  --network "name=${COMPOSE_PROJECT_NAME}_controller-provider,alias=stage3-model-peer" \
  -e "ANTNEST_E2E_SKILL_DELIVERY=${ANTNEST_E2E_SKILL_DELIVERY:-false}" \
  -e "ANTNEST_E2E_SKILL_REGISTRY_OUTAGE=${ANTNEST_E2E_SKILL_REGISTRY_OUTAGE:-false}" \
  -e "ANTNEST_E2E_SKILL_OFFLINE_REUSE=${ANTNEST_E2E_SKILL_OFFLINE_REUSE:-false}" \
  -e "ANTNEST_E2E_SKILL_MOUNT_RACE=${ANTNEST_E2E_SKILL_MOUNT_RACE:-false}" \
  -e "ANTNEST_E2E_SKILL_INITIALIZE_RACE=${ANTNEST_E2E_SKILL_INITIALIZE_RACE:-false}" \
  -e "ANTNEST_E2E_SKILL_MOUNT_RESPONSE_LOSS=${ANTNEST_E2E_SKILL_MOUNT_RESPONSE_LOSS:-false}" \
  -e "ANTNEST_E2E_SKILL_START_RESPONSE_LOSS=${ANTNEST_E2E_SKILL_START_RESPONSE_LOSS:-false}" \
  -e "ANTNEST_E2E_REGISTRY_IP=$registry_ip" \
  -v "$root/tests:/app/tests:ro" \
  antnest/agent-acp-service:local node /app/tests/e2e/stage3-base/model-server.mjs >/dev/null
fault_network=
if [ "${ANTNEST_E2E_SKILL_MOUNT_RACE:-false}" = true ] || [ "${ANTNEST_E2E_SKILL_INITIALIZE_RACE:-false}" = true ] || [ "${ANTNEST_E2E_SKILL_START_RESPONSE_LOSS:-false}" = true ]; then
  fault_network="--network ${COMPOSE_PROJECT_NAME}_skill-fault"
fi
# The client signs in through edge-gateway and reads Runtime Controller and
# Agent Controller with the per-run credentials those services admit.
# shellcheck disable=SC2086 # fault_network and service_hosts are option lists.
docker_cmd create --name "$client" $service_hosts --label "com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
  --network "${COMPOSE_PROJECT_NAME}_gateway-ingress" \
  --network "${COMPOSE_PROJECT_NAME}_controller-runtime" \
  --network "${COMPOSE_PROJECT_NAME}_controller-clients" \
  --network "${COMPOSE_PROJECT_NAME}_identity-clients" \
  --network "${COMPOSE_PROJECT_NAME}_observability" \
  --network "${COMPOSE_PROJECT_NAME}_acp-provider" \
  $fault_network \
  --user "$ANTNEST_SERVICE_AUTH_UID:$ANTNEST_SERVICE_AUTH_GID" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/agent-controller/tokens/runtime-controller:/run/auth/controller-runtime:ro" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/admin-console/tokens/agent-controller:/run/auth/console-controller:ro" \
  -v "$ANTNEST_SERVICE_AUTH_DIRECTORY/edge-gateway/tokens/identity-service:/run/auth/gateway-identity:ro" \
  -e "TEST_RUNTIME_IMAGE=$image" \
  -e "ANTNEST_E2E_SKILL_DELIVERY=${ANTNEST_E2E_SKILL_DELIVERY:-false}" \
  -e "ANTNEST_E2E_SKILL_READY_LOSS=${ANTNEST_E2E_SKILL_READY_LOSS:-false}" \
  -e "ANTNEST_E2E_SKILL_READY_DRIFT=${ANTNEST_E2E_SKILL_READY_DRIFT:-false}" \
  -e "ANTNEST_E2E_SKILL_TARGET_DRIFT=${ANTNEST_E2E_SKILL_TARGET_DRIFT:-false}" \
  -e "ANTNEST_E2E_SKILL_REGISTRY_OUTAGE=${ANTNEST_E2E_SKILL_REGISTRY_OUTAGE:-false}" \
  -e "ANTNEST_E2E_SKILL_OFFLINE_REUSE=${ANTNEST_E2E_SKILL_OFFLINE_REUSE:-false}" \
  -e "ANTNEST_E2E_SKILL_MOUNT_RACE=${ANTNEST_E2E_SKILL_MOUNT_RACE:-false}" \
  -e "ANTNEST_E2E_SKILL_INITIALIZE_RACE=${ANTNEST_E2E_SKILL_INITIALIZE_RACE:-false}" \
  -e "ANTNEST_E2E_SKILL_MOUNT_RESPONSE_LOSS=${ANTNEST_E2E_SKILL_MOUNT_RESPONSE_LOSS:-false}" \
  -e "ANTNEST_E2E_SKILL_START_RESPONSE_LOSS=${ANTNEST_E2E_SKILL_START_RESPONSE_LOSS:-false}" \
  -e "ANTNEST_E2E_SKILL_FENCED_INVALIDATION=${ANTNEST_E2E_SKILL_FENCED_INVALIDATION:-false}" \
  -e "ANTNEST_E2E_SKILL_RESTART_REBUILD=${ANTNEST_E2E_SKILL_RESTART_REBUILD:-false}" \
  -e "ANTNEST_E2E_LEGACY_INVENTORY=${ANTNEST_E2E_LEGACY_INVENTORY:-false}" \
  -e "ANTNEST_E2E_LEGACY_HELPER_ID=$legacy_helper_id" \
  -v "$root/tests:/app/tests:ro" \
  antnest/agent-acp-service:local node /app/tests/e2e/stage3-base/client.mjs >/dev/null
docker_cmd start "$client" >/dev/null
fault_volume=
verified_fault=false
fenced_fault_volume=
verified_fenced_fault=false
verified_rebuild_restart=false
target_drift_volume=
verified_target_drift=false
registry_stopped=false
registry_restored=false
reuse_registry_stopped=false
reuse_registry_restored=false
reuse_volume=
while [ "$(docker_cmd inspect --format '{{.State.Running}}' "$client")" = true ]; do
  if [ "${ANTNEST_E2E_SKILL_OFFLINE_REUSE:-false}" = true ]; then
    if [ "$reuse_registry_stopped" = false ] && docker_cmd exec "$client" test -f /tmp/stage3-offline-reuse.request >/dev/null 2>&1; then
      reuse_agent_id=$(docker_cmd exec "$client" cat /tmp/stage3-offline-reuse.request)
      reuse_volume=$(node "$root/tests/e2e/stage3-base/skill-ready-loss.mjs" snapshot "$COMPOSE_PROJECT_NAME" "$reuse_agent_id")
      docker_cmd stop "$registry_container" >/dev/null
      reuse_registry_stopped=true
      docker_cmd exec "$client" touch /tmp/stage3-offline-reuse.stopped >/dev/null
    fi
    if [ "$reuse_registry_stopped" = true ] && [ "$reuse_registry_restored" = false ] && docker_cmd exec "$client" test -f /tmp/stage3-offline-reuse.restore >/dev/null 2>&1; then
      [ "$(docker_cmd inspect --format '{{.State.Running}}' "$registry_container")" = false ] || { echo 'Skill Registry recovered before offline reuse verification' >&2; exit 1; }
      actual_reuse_volume=$(node "$root/tests/e2e/stage3-base/skill-ready-loss.mjs" snapshot "$COMPOSE_PROJECT_NAME" "$reuse_agent_id")
      [ "$actual_reuse_volume" = "$reuse_volume" ] || { echo 'Offline lifecycle replaced the retained Skill volume' >&2; exit 1; }
      docker_cmd start "$registry_container" >/dev/null
      for _ in $(seq 1 60); do
        [ "$(docker_cmd inspect --format '{{.State.Health.Status}}' "$registry_container")" = healthy ] && break
        sleep 1
      done
      [ "$(docker_cmd inspect --format '{{.State.Health.Status}}' "$registry_container")" = healthy ] || { echo 'Skill Registry did not recover' >&2; exit 1; }
      reuse_registry_restored=true
      docker_cmd exec "$client" touch /tmp/stage3-offline-reuse.restored >/dev/null
    fi
  fi
  if [ "${ANTNEST_E2E_SKILL_REGISTRY_OUTAGE:-false}" = true ]; then
    if [ "$registry_stopped" = false ] && docker_cmd exec "$client" test -f /tmp/stage3-registry-outage.request >/dev/null 2>&1; then
      docker_cmd stop "$registry_container" >/dev/null
      registry_stopped=true
      docker_cmd exec "$client" touch /tmp/stage3-registry-outage.stopped >/dev/null
    fi
    if [ "$registry_stopped" = true ] && [ "$registry_restored" = false ] && docker_cmd exec "$client" test -f /tmp/stage3-registry-outage.restore >/dev/null 2>&1; then
      docker_cmd start "$registry_container" >/dev/null
      for _ in $(seq 1 60); do
        [ "$(docker_cmd inspect --format '{{.State.Health.Status}}' "$registry_container")" = healthy ] && break
        sleep 1
      done
      [ "$(docker_cmd inspect --format '{{.State.Health.Status}}' "$registry_container")" = healthy ] || { echo 'Skill Registry did not recover' >&2; exit 1; }
      registry_restored=true
      docker_cmd exec "$client" touch /tmp/stage3-registry-outage.restored >/dev/null
    fi
  fi
  if [ "${ANTNEST_E2E_SKILL_TARGET_DRIFT:-false}" = true ]; then
    if [ -z "$target_drift_volume" ] && docker_cmd exec "$client" test -f /tmp/stage3-target-drift.request >/dev/null 2>&1; then
      agent_id=$(docker_cmd exec "$client" cat /tmp/stage3-target-drift.request)
      target_drift_volume=$(node "$root/tests/e2e/stage3-base/skill-target-drift.mjs" tamper "$COMPOSE_PROJECT_NAME" "$agent_id")
      docker_cmd exec "$client" touch /tmp/stage3-target-drift.injected >/dev/null
    fi
    if [ -n "$target_drift_volume" ] && [ "$verified_target_drift" = false ] && docker_cmd exec "$client" test -f /tmp/stage3-target-drift.prepared >/dev/null 2>&1; then
      node "$root/tests/e2e/stage3-base/skill-target-drift.mjs" verify "$COMPOSE_PROJECT_NAME" "$agent_id" "$target_drift_volume"
      verified_target_drift=true
      docker_cmd exec "$client" touch /tmp/stage3-target-drift.verified >/dev/null
    fi
  fi
  if [ "${ANTNEST_E2E_SKILL_FENCED_INVALIDATION:-false}" = true ]; then
    if [ -z "$fenced_fault_volume" ] && docker_cmd exec "$client" test -f /tmp/stage3-fenced-fault.fenced >/dev/null 2>&1; then
      agent_id=$(docker_cmd exec "$client" cat /tmp/stage3-fenced-fault.fenced)
      fenced_fault_volume=$(node "$root/tests/e2e/stage3-base/skill-fenced-invalidation.mjs" "$COMPOSE_PROJECT_NAME" "$agent_id")
      docker_cmd exec "$client" touch /tmp/stage3-fenced-fault.injected >/dev/null
    fi
    if [ -n "$fenced_fault_volume" ] && [ "$verified_fenced_fault" = false ] && docker_cmd exec "$client" test -f /tmp/stage3-fenced-fault.verified >/dev/null 2>&1; then
      verified_fenced_fault=true
    fi
  fi
  if [ "${ANTNEST_E2E_SKILL_RESTART_REBUILD:-false}" = true ] && [ "$verified_rebuild_restart" = false ] && docker_cmd exec "$client" test -f /tmp/stage3-restart-rebuild.request >/dev/null 2>&1; then
    agent_id=$(docker_cmd exec "$client" cat /tmp/stage3-restart-rebuild.request)
    pending=$(docker_cmd exec "$fault_proxy" node -e 'fetch("http://127.0.0.1:8080/fault/pending").then(r=>r.json()).then(v=>process.stdout.write(v.pending? v.agent_id:""))')
    [ "$pending" = "$agent_id" ] || { echo 'RC Update is not fenced before restart' >&2; exit 1; }
    controller_container=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter 'label=com.docker.compose.service=agent-controller')
    runtime_controller_container=$(docker_cmd ps -q --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" --filter 'label=com.docker.compose.service=runtime-controller')
    [ -n "$controller_container" ] && [ -n "$runtime_controller_container" ] || { echo 'Controller or RC container missing' >&2; exit 1; }
    docker_cmd restart "$controller_container" >/dev/null
    docker_cmd restart "$runtime_controller_container" >/dev/null
    for _ in $(seq 1 90); do
      if [ "$(docker_cmd inspect --format '{{.State.Health.Status}}' "$controller_container")" = healthy ] && [ "$(docker_cmd inspect --format '{{.State.Health.Status}}' "$runtime_controller_container")" = healthy ]; then break; fi
      sleep 1
    done
    [ "$(docker_cmd inspect --format '{{.State.Health.Status}}' "$controller_container")" = healthy ] && [ "$(docker_cmd inspect --format '{{.State.Health.Status}}' "$runtime_controller_container")" = healthy ] || { echo 'Controller or RC did not recover' >&2; exit 1; }
    verified_rebuild_restart=true
    docker_cmd exec "$client" touch /tmp/stage3-restart-rebuild.restarted >/dev/null
  fi
  if [ "${ANTNEST_E2E_SKILL_READY_LOSS:-false}" = true ] || [ "${ANTNEST_E2E_SKILL_READY_DRIFT:-false}" = true ]; then
    if [ -z "$fault_volume" ] && docker_cmd exec "$client" test -f /tmp/stage3-ready-fault.request >/dev/null 2>&1; then
      agent_id=$(docker_cmd exec "$client" cat /tmp/stage3-ready-fault.request)
      action=delete
      [ "${ANTNEST_E2E_SKILL_READY_DRIFT:-false}" = true ] && action=tamper
      fault_volume=$(node "$root/tests/e2e/stage3-base/skill-ready-loss.mjs" "$action" "$COMPOSE_PROJECT_NAME" "$agent_id")
      docker_cmd exec "$client" touch /tmp/stage3-ready-fault.injected >/dev/null
    fi
    if [ -n "$fault_volume" ] && [ "$verified_fault" = false ] && docker_cmd exec "$client" test -f /tmp/stage3-ready-fault.enabled >/dev/null 2>&1; then
      action=verify
      [ "${ANTNEST_E2E_SKILL_READY_DRIFT:-false}" = true ] && action=verify-drift
      node "$root/tests/e2e/stage3-base/skill-ready-loss.mjs" "$action" "$COMPOSE_PROJECT_NAME" "$agent_id" "$fault_volume"
      verified_fault=true
      docker_cmd exec "$client" touch /tmp/stage3-ready-fault.verified >/dev/null
    fi
  fi
  sleep 1
done
status=$(docker_cmd inspect --format '{{.State.ExitCode}}' "$client")
docker_cmd logs "$client"
if [ "$status" -ne 0 ] && { [ "${ANTNEST_E2E_SKILL_FENCED_INVALIDATION:-false}" = true ] || [ "${ANTNEST_E2E_SKILL_RESTART_REBUILD:-false}" = true ]; }; then
  docker_cmd logs "$fault_proxy" >&2
fi
if [ "${ANTNEST_E2E_SKILL_RESTART_REBUILD:-false}" = true ] && [ "$verified_rebuild_restart" != true ]; then
  echo 'Fenced Skill Rebuild restart was not verified' >&2
  status=1
fi
if { [ "${ANTNEST_E2E_SKILL_READY_LOSS:-false}" = true ] || [ "${ANTNEST_E2E_SKILL_READY_DRIFT:-false}" = true ]; } && [ "$verified_fault" != true ]; then
  echo 'Ready Skill volume fault was not verified' >&2
  status=1
fi
if [ "${ANTNEST_E2E_SKILL_FENCED_INVALIDATION:-false}" = true ] && [ "$verified_fenced_fault" != true ]; then
  echo 'Fenced Skill-set invalidation was not verified' >&2
  status=1
fi
if [ "${ANTNEST_E2E_SKILL_TARGET_DRIFT:-false}" = true ] && [ "$verified_target_drift" != true ]; then
  echo 'Target Skill drift was not verified' >&2
  status=1
fi
if [ "${ANTNEST_E2E_SKILL_REGISTRY_OUTAGE:-false}" = true ] && [ "$registry_restored" != true ]; then
  echo 'Skill Registry outage recovery was not verified' >&2
  status=1
fi
if [ "${ANTNEST_E2E_SKILL_OFFLINE_REUSE:-false}" = true ] && [ "$reuse_registry_restored" != true ]; then
  echo 'Offline Skill reuse was not verified' >&2
  status=1
fi
umask 077
mkdir -p "$evidence"
docker_cmd cp "$client:/tmp/stage3-traces" "$evidence/" >/dev/null 2>&1 || true
if docker_cmd cp "$client:/tmp/stage3-business.json" "$temporary/business.json" >/dev/null 2>&1; then
  node -e 'const assert=require("node:assert/strict"); const b=require(process.argv[1]); if(process.env.ANTNEST_E2E_SKILL_INITIALIZE_RACE==="true") { assert.equal(b.status,"skill_initialize_race_unknown"); assert.equal(b.rc_state,"unknown"); assert.equal(b.acp_admission_closed,true); } else if(process.env.ANTNEST_E2E_SKILL_MOUNT_RACE==="true") { const loss=process.env.ANTNEST_E2E_SKILL_MOUNT_RESPONSE_LOSS==="true"; assert.equal(b.status,"skill_mount_race_unknown"); assert.equal(b.rc_state,"unknown"); assert.equal(b.rc_error_code,loss?"skill_mount_verification_failed":"storage_ownership_conflict"); assert.equal(b.accepted_replay_preserved_unknown,!loss); assert.equal(b.create_response_dropped,loss); assert.equal(b.recovery_inspect_seen,loss); assert.equal(b.controller_state,"running"); assert.equal(b.acp_admission_closed,true); } else { assert.equal(b.status,"business_passed"); assert.equal(b.deleted,true); if(process.env.ANTNEST_E2E_SKILL_START_RESPONSE_LOSS==="true") { assert.equal(b.start_response_loss?.status,"running_skill_mount_recovered"); assert.equal(b.start_response_loss.start_response_dropped,true); assert.equal(b.start_response_loss.recovery_inspect_seen,true); } if(process.env.ANTNEST_E2E_SKILL_FENCED_INVALIDATION==="true") assert.equal(b.fenced_skill_invalidation?.status,"fenced_skill_invalidation_recovered"); if(process.env.ANTNEST_E2E_SKILL_TARGET_DRIFT==="true") assert.equal(b.target_skill_drift?.status,"target_skill_drift_recovered"); if(process.env.ANTNEST_E2E_SKILL_REGISTRY_OUTAGE==="true") assert.equal(b.registry_outage?.status,"registry_outage_recovered"); if(process.env.ANTNEST_E2E_SKILL_OFFLINE_REUSE==="true") assert.equal(b.offline_skill_reuse?.status,"offline_skill_reuse_passed"); }' "$temporary/business.json"
  cp "$temporary/business.json" "$evidence/business.json"
  if [ "${ANTNEST_E2E_SKILL_MOUNT_RACE:-false}" != true ] && [ "${ANTNEST_E2E_SKILL_INITIALIZE_RACE:-false}" != true ]; then
    [ -z "$(docker_cmd ps -aq --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME")" ] || { echo 'Deleted Agent retained a Runtime container' >&2; exit 1; }
    [ -z "$(docker_cmd volume ls -q --filter "label=io.antnest.runtime-controller-scope=$COMPOSE_PROJECT_NAME")" ] || { echo 'Deleted Agent retained a Runtime volume' >&2; exit 1; }
    echo '{"status":"deletion_resources_passed","runtime_containers":0,"runtime_volumes":0}'
  fi
else
  [ "$status" != 0 ] || status=1
fi
exit "$status"
