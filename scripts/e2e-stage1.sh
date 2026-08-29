#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository_root"

export COMPOSE_PROJECT_NAME="antnest-stage1-e2e-$$"
export ANTNEST_EGRESS_CONTROL_HOST_PORT=$((20000 + ($$ % 10000)))
export ANTNEST_EGRESS_POSTGRES_HOST_PORT=$((30000 + ($$ % 10000)))
export ANTNEST_RUNTIME_MANAGEMENT_NETWORK="${COMPOSE_PROJECT_NAME}-runtime-management"
network_octet=$((1 + ($$ % 200)))
export ANTNEST_RUNTIME_MANAGEMENT_SUBNET="10.253.${network_octet}.0/24"
export ANTNEST_EGRESS_IPV4="10.253.${network_octet}.3"

control_url="http://127.0.0.1:${ANTNEST_EGRESS_CONTROL_HOST_PORT}"
runtime_name="${COMPOSE_PROJECT_NAME}-runtime"
temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/antnest-stage1-e2e.XXXXXX")
workspace="$temporary_root/workspace"
resolver="$temporary_root/resolv.conf"

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then
    docker compose ps >&2 || true
    docker compose logs --no-color --tail=200 runtime-egress >&2 || true
    docker logs --tail=200 "$runtime_name" >&2 || true
  fi
  docker rm -f "$runtime_name" >/dev/null 2>&1 || true
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "${temporary_root:?}"
  exit "$status"
}
trap cleanup EXIT INT TERM

mkdir "$workspace"
chmod 0777 "$workspace"
printf 'options use-vc\nnameserver 100.64.0.1\n' >"$resolver"

docker compose up -d --wait postgres runtime-egress

curl -fsS "$control_url/status" | grep -q '"status":"ready"'
curl -fsS -X PUT \
  "$control_url/internal/agent-networks/agent-stage1-e2e" \
  | grep -q '"tunnel_ipv4":"100.64.0.2"'
curl -fsS -X PUT \
  -H 'content-type: application/json' \
  -d '{"spec":{"schema_version":1,"action":"allow_all"}}' \
  "$control_url/internal/policies/stage1-allow/revisions/1" \
  >/dev/null
curl -fsS -X PUT \
  -H 'content-type: application/json' \
  -d '{"policy_id":"stage1-allow","revision":1,"expected_resource_version":1}' \
  "$control_url/internal/agent-policy-assignments/agent-stage1-e2e" \
  >/dev/null

runtime_spec="{\"agent_id\":\"agent-stage1-e2e\",\"generation\":1,\"listen\":{\"host\":\"0.0.0.0\",\"port\":8093},\"network\":{\"packet_contract_revision\":1,\"egress_endpoint\":{\"ipv4\":\"${ANTNEST_EGRESS_IPV4}\",\"port\":8092},\"tunnel_ipv4\":\"100.64.0.2\",\"resolver_ipv4\":\"100.64.0.1\"},\"filesystem\":{\"workspace\":\"/workspace\",\"system_skills\":\"/skills\"}}"

docker run -d \
  --name "$runtime_name" \
  --read-only \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add DAC_OVERRIDE \
  --cap-add KILL \
  --cap-add NET_ADMIN \
  --cap-add SETGID \
  --cap-add SETPCAP \
  --cap-add SETUID \
  --device /dev/net/tun \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --mount "type=bind,src=$workspace,dst=/workspace" \
  --mount "type=bind,src=$resolver,dst=/etc/resolv.conf,readonly" \
  --network "$ANTNEST_RUNTIME_MANAGEMENT_NETWORK" \
  --env "ANTNEST_RUNTIME_SPEC=$runtime_spec" \
  --env OTEL_SDK_DISABLED=true \
  antnest/antnest-runtime:local \
  >/dev/null

attempt=0
until docker exec "$runtime_name" curl -fsS http://127.0.0.1:8093/status \
  2>/dev/null | grep -q '"generation":1,"status":"ready"'; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker logs "$runtime_name"
    echo "Runtime did not become ready" >&2
    exit 1
  fi
  sleep 1
done

echo "Checking allow_all data path"
docker exec --user 1000 "$runtime_name" \
  curl -kfsS --connect-timeout 5 --max-time 10 https://1.1.1.1 \
  >/dev/null
docker exec --user 1000 "$runtime_name" \
  curl -fsS --connect-timeout 5 --max-time 10 https://example.com \
  | grep -q 'Example Domain'

curl -fsS -X PUT \
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

curl -fsS -X PUT \
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
curl -fsS "$control_url/internal/agent-policy-assignments/agent-stage1-e2e" \
  | grep -q '"resource_version":4'
docker exec --user 1000 "$runtime_name" \
  curl -kfsS --connect-timeout 5 --max-time 10 https://1.1.1.1 \
  >/dev/null
docker exec --user 1000 "$runtime_name" \
  curl -fsS --connect-timeout 5 --max-time 10 https://example.com \
  | grep -q 'Example Domain'

curl -fsS -X POST \
  "$control_url/internal/agent-networks/agent-stage1-e2e/release" \
  | grep -q '"state":"quarantined"'

echo "Stage 1 Runtime/Egress E2E passed"
