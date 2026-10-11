-- Pairing grants a specific Provider binding side effect. Existing directory
-- credentials and Memberships have no such grant; do not infer one from email.
ALTER TABLE scim_tokens
    ADD COLUMN oidc_provider_id TEXT,
    ADD CONSTRAINT scim_tokens_oidc_provider_fk
        FOREIGN KEY (organization_id, oidc_provider_id)
        REFERENCES oidc_providers (organization_id, id);

ALTER TABLE organization_memberships
    ADD COLUMN scim_oidc_provider_id TEXT,
    ADD CONSTRAINT organization_memberships_scim_oidc_provider_fk
        FOREIGN KEY (organization_id, scim_oidc_provider_id)
        REFERENCES oidc_providers (organization_id, id),
    ADD CONSTRAINT organization_memberships_scim_pairing_shape CHECK (
        scim_oidc_provider_id IS NULL OR (
            source = 'scim' AND scim_external_id IS NOT NULL
            AND char_length(scim_external_id) BETWEEN 1 AND 255
        )
    );
