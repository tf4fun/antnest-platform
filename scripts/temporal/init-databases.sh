#!/bin/sh
set -eu

psql --set=ON_ERROR_STOP=1 --dbname=postgres --set=password="$ANTNEST_TEMPORAL_POSTGRES_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE antnest_temporal LOGIN PASSWORD %L', :'password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'antnest_temporal')
\gexec
SELECT format('CREATE DATABASE %I OWNER antnest_temporal', name)
FROM (VALUES ('antnest_temporal'), ('antnest_temporal_visibility')) AS databases(name)
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = name)
\gexec
REVOKE CONNECT ON DATABASE antnest_temporal, antnest_temporal_visibility FROM PUBLIC;
GRANT CONNECT ON DATABASE antnest_temporal, antnest_temporal_visibility TO antnest_temporal;
SQL
