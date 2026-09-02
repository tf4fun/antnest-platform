#!/bin/sh
set -eu

create_service_database() {
  role_name=$1
  role_password=$2
  database_name=$3

  psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    --set=role_name="$role_name" \
    --set=role_password="$role_password" \
    --set=database_name="$database_name" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role_name', :'role_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role_name')
\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'database_name', :'role_name')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'database_name')
\gexec
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'database_name')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database_name', :'role_name')
\gexec
SQL
}

create_service_database \
  antnest_egress "$ANTNEST_EGRESS_POSTGRES_PASSWORD" antnest_egress
create_service_database \
  antnest_runtime_controller "$ANTNEST_RUNTIME_CONTROLLER_POSTGRES_PASSWORD" \
  antnest_runtime_controller
create_service_database \
  antnest_agent_acp "$ANTNEST_AGENT_ACP_POSTGRES_PASSWORD" antnest_agent_acp
create_service_database \
  antnest_identity "$ANTNEST_IDENTITY_POSTGRES_PASSWORD" antnest_identity
create_service_database \
  antnest_agent_controller "$ANTNEST_AGENT_CONTROLLER_POSTGRES_PASSWORD" \
  antnest_agent_controller

touch "$PGDATA/.antnest-init-complete"
