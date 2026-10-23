package postgres

const acpIncarnationSQL = `
CREATE TABLE runtime_controller.acp_incarnation_registrations (
    controller_scope TEXT NOT NULL CHECK (length(controller_scope) BETWEEN 1 AND 200 AND btrim(controller_scope)=controller_scope),
    registration_id TEXT NOT NULL CHECK (registration_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    member_id TEXT NOT NULL CHECK (length(member_id) BETWEEN 1 AND 64 AND member_id ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
    incarnation_id TEXT NOT NULL CHECK (incarnation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    nonce_digest BYTEA NOT NULL CHECK (octet_length(nonce_digest)=32),
    engine_id TEXT NOT NULL CHECK (length(engine_id) BETWEEN 1 AND 256 AND engine_id !~ '[[:space:][:cntrl:]]'),
    container_id TEXT NOT NULL CHECK (container_id ~ '^[0-9a-f]{64}$'),
    started_at TEXT NOT NULL CHECK (length(started_at) BETWEEN 20 AND 30),
    stop_receipt_id TEXT CHECK (stop_receipt_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
    stop_reason TEXT CHECK (stop_reason IN ('container_stopped','container_restarted','container_removed')),
    stopped_at TIMESTAMPTZ,
    PRIMARY KEY (controller_scope,registration_id),
    UNIQUE (controller_scope,member_id,incarnation_id),
    UNIQUE (controller_scope,stop_receipt_id),
    CHECK ((stop_receipt_id IS NULL AND stop_reason IS NULL AND stopped_at IS NULL)
        OR (stop_receipt_id IS NOT NULL AND stop_reason IS NOT NULL AND stopped_at IS NOT NULL))
);
`
