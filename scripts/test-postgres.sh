#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repository_root"

export COMPOSE_PROJECT_NAME="antnest-postgres-tests-$$"
export ANTNEST_POSTGRES_HOST_PORT=$((30000 + ($$ % 10000)))

cleanup() {
  status=$?
  trap - EXIT INT TERM
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT INT TERM

make test-egress-postgres
make test-runtime-controller-postgres
make test-agent-acp-postgres
make test-identity-postgres
make test-agent-controller-postgres
