-- Public connection identity only. Bearers remain in process-private sender files.
-- Existing intents have no recoverable private authority and stay fail-closed.
ALTER TABLE learning_maintenance_intents
    ADD COLUMN runtime_revision text,
    ADD COLUMN connection_id text,
    ADD CONSTRAINT learning_maintenance_connection_identity CHECK (
        (runtime_revision IS NULL AND connection_id IS NULL)
        OR (runtime_revision IS NOT NULL AND connection_id IS NOT NULL
            AND runtime_revision ~ '^rtv_[0-9a-f]{32}$'
            AND connection_id ~ '^rci_[0-9a-f]{32}$')
    );
