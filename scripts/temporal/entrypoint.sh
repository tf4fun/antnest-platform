#!/bin/sh
set -eu

ANTNEST_TEMPORAL_POSTGRES_PASSWORD=${POSTGRES_PWD-} \
  sh /etc/temporal/development-secret-admission.sh ANTNEST_TEMPORAL_POSTGRES_PASSWORD

exec /etc/temporal/entrypoint-upstream.sh "$@"
