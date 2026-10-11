ALTER TABLE external_identities
    ADD COLUMN method TEXT NOT NULL DEFAULT 'auto' CHECK (method IN ('auto', 'admin', 'scim')),
    ADD COLUMN bound_at TIMESTAMPTZ,
    ADD COLUMN revoked_at TIMESTAMPTZ;

UPDATE external_identities SET bound_at = created_at;
ALTER TABLE external_identities ALTER COLUMN bound_at SET NOT NULL;
ALTER TABLE external_identities ALTER COLUMN bound_at SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE external_identities DROP CONSTRAINT external_identities_provider_user_unique;
CREATE UNIQUE INDEX external_identities_active_provider_user_unique
    ON external_identities (provider_id, user_id) WHERE revoked_at IS NULL;

-- Notices are immutable display snapshots. A later rename, reprovision or
-- revocation must not rewrite an earlier notification. There is no backfill:
-- adding history metadata is not a newly activated sign-in method.
CREATE TABLE external_identity_notices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    binding_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    provider_display_name TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    organization_slug TEXT NOT NULL,
    organization_name TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('auto', 'admin', 'scim')),
    created_at TIMESTAMPTZ NOT NULL,
    acknowledged_at TIMESTAMPTZ
);
CREATE INDEX external_identity_notices_pending_user_idx
    ON external_identity_notices (user_id, id) WHERE acknowledged_at IS NULL;
CREATE INDEX external_identities_user_inventory_idx ON external_identities (user_id, id);
