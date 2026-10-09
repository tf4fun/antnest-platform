#!/bin/sh
set -eu

ANTNEST_POSTGRES_ADMIN_PASSWORD=${PGPASSWORD-} \
  sh /scripts/development-secret-admission.sh ANTNEST_POSTGRES_ADMIN_PASSWORD

psql --set=ON_ERROR_STOP=1 --dbname postgres \
  --set=role_password="$ANTNEST_SKILL_REGISTRY_POSTGRES_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', 'antnest_skill_registry', :'role_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'antnest_skill_registry')
\gexec
SELECT format('CREATE DATABASE %I OWNER %I', 'antnest_skill_registry', 'antnest_skill_registry')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'antnest_skill_registry')
\gexec
REVOKE CONNECT ON DATABASE antnest_skill_registry FROM PUBLIC;
GRANT CONNECT ON DATABASE antnest_skill_registry TO antnest_skill_registry;
SQL
