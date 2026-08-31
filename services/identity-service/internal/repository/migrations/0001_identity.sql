CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT organizations_slug_normalized CHECK (slug = lower(btrim(slug)))
);

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT,
    system_role TEXT NOT NULL,
    source TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT users_email_normalized CHECK (email = lower(btrim(email))),
    CONSTRAINT users_system_role_valid CHECK (system_role IN ('user', 'admin')),
    CONSTRAINT users_source_valid CHECK (source IN ('local', 'oidc', 'scim')),
    CONSTRAINT users_password_source CHECK ((source = 'local') = (password_hash IS NOT NULL))
);

CREATE TABLE organization_memberships (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    source TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    scim_external_id TEXT,
    scim_user_name TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT organization_memberships_role_valid CHECK (role IN ('member', 'admin')),
    CONSTRAINT organization_memberships_source_valid CHECK (source IN ('local', 'oidc', 'scim')),
    CONSTRAINT organization_memberships_scim_shape CHECK (
        source = 'scim' OR (scim_external_id IS NULL AND scim_user_name IS NULL)
    ),
    CONSTRAINT organization_memberships_org_id_unique UNIQUE (organization_id, id),
    CONSTRAINT organization_memberships_org_id_user_identity_unique UNIQUE (organization_id, id, user_id),
    CONSTRAINT organization_memberships_org_user_unique UNIQUE (organization_id, user_id)
);

CREATE UNIQUE INDEX organization_memberships_scim_external_unique
    ON organization_memberships (organization_id, scim_external_id)
    WHERE source = 'scim' AND scim_external_id IS NOT NULL;
CREATE UNIQUE INDEX organization_memberships_scim_username_unique
    ON organization_memberships (organization_id, scim_user_name)
    WHERE source = 'scim' AND scim_user_name IS NOT NULL;

CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    source TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    scim_external_id TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT groups_source_valid CHECK (source IN ('local', 'oidc', 'scim')),
    CONSTRAINT groups_scim_shape CHECK (source = 'scim' OR scim_external_id IS NULL),
    CONSTRAINT groups_org_id_unique UNIQUE (organization_id, id)
);

CREATE UNIQUE INDEX groups_scim_external_unique
    ON groups (organization_id, scim_external_id)
    WHERE source = 'scim' AND scim_external_id IS NOT NULL;

CREATE TABLE group_memberships (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    organization_membership_id TEXT NOT NULL,
    source TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT group_memberships_source_valid CHECK (source IN ('local', 'oidc', 'scim')),
    CONSTRAINT group_memberships_group_fk FOREIGN KEY (organization_id, group_id)
        REFERENCES groups (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT group_memberships_member_fk FOREIGN KEY (organization_id, organization_membership_id)
        REFERENCES organization_memberships (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT group_memberships_owner_unique UNIQUE (group_id, organization_membership_id, source)
);

CREATE TABLE oidc_providers (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    issuer TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_secret_ciphertext BYTEA NOT NULL,
    client_secret_nonce BYTEA NOT NULL,
    redirect_uri TEXT NOT NULL,
    scopes TEXT[] NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    authorization_endpoint TEXT NOT NULL,
    token_endpoint TEXT NOT NULL,
    userinfo_endpoint TEXT NOT NULL DEFAULT '',
    jwks_uri TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT oidc_providers_name_normalized CHECK (name = lower(btrim(name))),
    CONSTRAINT oidc_providers_org_id_unique UNIQUE (organization_id, id),
    CONSTRAINT oidc_providers_org_name_unique UNIQUE (organization_id, name),
    CONSTRAINT oidc_providers_org_issuer_unique UNIQUE (organization_id, issuer)
);

CREATE TABLE external_identities (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT external_identities_provider_fk FOREIGN KEY (organization_id, provider_id)
        REFERENCES oidc_providers (organization_id, id) ON DELETE RESTRICT,
    CONSTRAINT external_identities_membership_fk FOREIGN KEY (organization_id, membership_id, user_id)
        REFERENCES organization_memberships (organization_id, id, user_id) ON DELETE RESTRICT,
    CONSTRAINT external_identities_subject_unique UNIQUE (provider_id, subject),
    CONSTRAINT external_identities_provider_user_unique UNIQUE (provider_id, user_id)
);

CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    membership_id TEXT NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    CONSTRAINT api_tokens_org_identity_unique UNIQUE (organization_id, id, user_id, membership_id),
    CONSTRAINT api_tokens_membership_fk FOREIGN KEY (organization_id, membership_id, user_id)
        REFERENCES organization_memberships (organization_id, id, user_id) ON DELETE CASCADE
);

CREATE INDEX api_tokens_active_hash_idx ON api_tokens (token_hash) WHERE revoked_at IS NULL;

CREATE TABLE oidc_auth_sessions (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    state_hash TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL,
    status TEXT NOT NULL,
    secret_ciphertext BYTEA NOT NULL,
    secret_nonce BYTEA NOT NULL,
    claim_id TEXT,
    claimed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    completed_user_id TEXT,
    completed_membership_id TEXT,
    completed_access_token_id TEXT REFERENCES api_tokens(id) ON DELETE RESTRICT,
    completed_at TIMESTAMPTZ,
    failure_stage TEXT,
    failure_reason TEXT,
    failed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT oidc_auth_sessions_status_valid CHECK (status IN ('pending', 'exchanging', 'completed', 'failed')),
    CONSTRAINT oidc_auth_sessions_provider_fk FOREIGN KEY (organization_id, provider_id)
        REFERENCES oidc_providers (organization_id, id) ON DELETE CASCADE,
    CONSTRAINT oidc_auth_sessions_token_fk FOREIGN KEY (
        organization_id, completed_access_token_id, completed_user_id, completed_membership_id
    ) REFERENCES api_tokens (organization_id, id, user_id, membership_id) ON DELETE RESTRICT,
    CONSTRAINT oidc_auth_sessions_completion_shape CHECK (
        (status = 'completed' AND completed_user_id IS NOT NULL AND completed_membership_id IS NOT NULL
            AND completed_access_token_id IS NOT NULL AND completed_at IS NOT NULL)
        OR status <> 'completed'
    )
);

CREATE TABLE scim_tokens (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    scopes TEXT[] NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ
);

CREATE INDEX scim_tokens_active_hash_idx ON scim_tokens (token_hash) WHERE revoked_at IS NULL;

CREATE TABLE identity_events (
    sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    organization_id TEXT,
    actor_principal_id TEXT,
    actor_scim_token_id TEXT,
    event_type TEXT NOT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    request_id TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT identity_events_single_actor CHECK (
        actor_principal_id IS NULL OR actor_scim_token_id IS NULL
    )
);

CREATE INDEX identity_events_org_sequence_idx ON identity_events (organization_id, sequence);
