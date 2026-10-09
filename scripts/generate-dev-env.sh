#!/bin/sh
set -eu
umask 077

dev_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
dev_output="$dev_root/.env"
dev_force=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      [ "$#" -ge 2 ] || { echo "--output requires a path" >&2; exit 1; }
      dev_output=$2
      shift 2
      ;;
    --force) dev_force=true; shift ;;
    --help)
      echo "Usage: scripts/generate-dev-env.sh [--output PATH] [--force]"
      exit 0
      ;;
    *) echo "Unknown argument" >&2; exit 1 ;;
  esac
done

dev_socket_gid=${ANTNEST_DOCKER_SOCKET_GID:-}
case "$dev_socket_gid" in
  ''|0) ;;
  *[!0-9]*|0*) echo "ANTNEST_DOCKER_SOCKET_GID must be a decimal socket group ID" >&2; exit 1 ;;
  *)
    if [ "${#dev_socket_gid}" -gt 10 ] || [ "$dev_socket_gid" -gt 4294967294 ]; then
      echo "ANTNEST_DOCKER_SOCKET_GID must be a valid socket group ID" >&2
      exit 1
    fi
    ;;
esac

[ ! -L "$dev_output" ] || { echo "Refusing a symbolic-link output" >&2; exit 1; }
if [ -e "$dev_output" ]; then
  [ -f "$dev_output" ] || { echo "Output must be a regular file" >&2; exit 1; }
  [ "$dev_force" = true ] || { echo "Output already exists; use --force only for disposable data" >&2; exit 1; }
fi
command -v openssl >/dev/null 2>&1 || { echo "OpenSSL is required" >&2; exit 1; }
dev_directory=$(dirname -- "$dev_output")
dev_temp=$(mktemp -d "$dev_directory/.antnest-dev-env.XXXXXX")
trap 'rm -rf -- "$dev_temp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'ANTNEST_DOCKER_SOCKET_GID=%s\n' "$dev_socket_gid" > "$dev_temp/values"

for dev_name in \
  ANTNEST_POSTGRES_ADMIN_PASSWORD \
  ANTNEST_EGRESS_POSTGRES_PASSWORD \
  ANTNEST_RUNTIME_CONTROLLER_POSTGRES_PASSWORD \
  ANTNEST_AGENT_ACP_POSTGRES_PASSWORD \
  ANTNEST_IDENTITY_POSTGRES_PASSWORD \
  ANTNEST_AGENT_CONTROLLER_POSTGRES_PASSWORD \
  ANTNEST_SKILL_REGISTRY_POSTGRES_PASSWORD \
  ANTNEST_TEMPORAL_POSTGRES_PASSWORD \
  ANTNEST_BOOTSTRAP_ADMIN_PASSWORD; do
  dev_value=$(openssl rand -hex 24)
  printf '%s=%s\n' "$dev_name" "$dev_value" >> "$dev_temp/values"
  if [ "$dev_name" = ANTNEST_BOOTSTRAP_ADMIN_PASSWORD ]; then dev_admin_password=$dev_value; fi
done
for dev_name in \
  ANTNEST_IDENTITY_ENCRYPTION_KEY \
  ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY \
  ANTNEST_ACP_CLIENT_MCP_KEY; do
  dev_value=$(openssl rand -base64 32)
  printf '%s=%s\n' "$dev_name" "$dev_value" >> "$dev_temp/values"
done
awk -F= '
  FNR == NR { values[$1] = substr($0, index($0, "=") + 1); next }
  $1 in values { print $1 "=" values[$1]; next }
  { print }
' "$dev_temp/values" "$dev_root/.env.example" > "$dev_temp/env"
chmod 600 "$dev_temp/env"
if [ "$dev_force" = true ]; then
  mv -f -- "$dev_temp/env" "$dev_output"
else
  # Exclusive publication also protects against a concurrent generator.
  ln -- "$dev_temp/env" "$dev_output"
fi
printf 'Bootstrap administrator password: %s\n' "$dev_admin_password"
