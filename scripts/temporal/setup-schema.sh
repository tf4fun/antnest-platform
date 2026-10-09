#!/bin/sh
set -eu

ANTNEST_TEMPORAL_POSTGRES_PASSWORD=${SQL_PASSWORD-} \
  sh /scripts/development-secret-admission.sh ANTNEST_TEMPORAL_POSTGRES_PASSWORD

for schema in temporal visibility; do
  database=antnest_temporal
  if [ "$schema" = visibility ]; then database=antnest_temporal_visibility; fi
  temporal-sql-tool --plugin postgres12 --ep postgres --port 5432 \
    --user antnest_temporal --database "$database" setup-schema --version 0.0
  temporal-sql-tool --plugin postgres12 --ep postgres --port 5432 \
    --user antnest_temporal --database "$database" update-schema \
    --schema-dir "/etc/temporal/schema/postgresql/v12/$schema/versioned"
done
