CREATE SCHEMA IF NOT EXISTS runtime_egress;

CREATE TABLE IF NOT EXISTS runtime_egress.schema_migrations (
    version bigint PRIMARY KEY,
    name text NOT NULL UNIQUE,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
