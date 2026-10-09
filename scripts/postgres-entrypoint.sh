#!/bin/sh
set -eu

ANTNEST_POSTGRES_ADMIN_PASSWORD=${POSTGRES_PASSWORD-} \
  sh /scripts/development-secret-admission.sh ANTNEST_POSTGRES_ADMIN_PASSWORD

exec docker-entrypoint.sh "$@"
