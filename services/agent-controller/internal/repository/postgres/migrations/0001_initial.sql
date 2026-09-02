CREATE SCHEMA IF NOT EXISTS agent_controller;

CREATE TABLE IF NOT EXISTS agent_controller.schema_migrations (
    version BIGINT PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_controller.catalog_requests (
    request_id TEXT PRIMARY KEY,
    request_kind TEXT NOT NULL CHECK (request_kind IN (
        'create_model_profile', 'revise_model_profile',
        'create_template', 'revise_template'
    )),
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    resource_id TEXT NOT NULL,
    revision_id TEXT NOT NULL DEFAULT '',
    revision BIGINT NOT NULL CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_controller.provider_credentials (
    credential_ref TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    credential_version TEXT NOT NULL UNIQUE,
    secret_type TEXT NOT NULL CHECK (secret_type = 'bearer'),
    ciphertext BYTEA NOT NULL,
    nonce BYTEA NOT NULL,
    key_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (credential_ref, organization_id, credential_version)
);

CREATE TABLE IF NOT EXISTS agent_controller.model_profiles (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    profile_key TEXT NOT NULL,
    display_name TEXT NOT NULL CHECK (display_name <> ''),
    current_revision_id TEXT NOT NULL,
    current_revision BIGINT NOT NULL CHECK (current_revision > 0),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (organization_id, profile_key)
);

CREATE TABLE IF NOT EXISTS agent_controller.model_profile_revisions (
    id TEXT PRIMARY KEY,
    model_profile_id TEXT NOT NULL REFERENCES agent_controller.model_profiles(id),
    organization_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    model JSONB NOT NULL,
    credential_ref TEXT NOT NULL,
    credential_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (model_profile_id, revision),
    UNIQUE (id, organization_id),
    UNIQUE (id, model_profile_id, organization_id, revision),
    CONSTRAINT model_profile_credential_fk
        FOREIGN KEY (credential_ref, organization_id, credential_version)
        REFERENCES agent_controller.provider_credentials (
            credential_ref, organization_id, credential_version
        )
);

ALTER TABLE agent_controller.model_profiles
    ADD CONSTRAINT model_profile_head_fk
    FOREIGN KEY (current_revision_id, id, organization_id, current_revision)
    REFERENCES agent_controller.model_profile_revisions (
        id, model_profile_id, organization_id, revision
    )
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS agent_controller.agent_templates (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    template_key TEXT NOT NULL,
    name TEXT NOT NULL CHECK (name <> ''),
    current_revision BIGINT NOT NULL CHECK (current_revision > 0),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (organization_id, template_key)
);

CREATE TABLE IF NOT EXISTS agent_controller.agent_template_revisions (
    template_id TEXT NOT NULL REFERENCES agent_controller.agent_templates(id),
    organization_id TEXT NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    model_profile_revision_id TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    max_model_requests INTEGER NOT NULL CHECK (max_model_requests BETWEEN 1 AND 128),
    context_policy_version TEXT NOT NULL,
    runtime_input JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (template_id, revision),
    UNIQUE (template_id, organization_id, revision),
    CONSTRAINT template_model_revision_fk
        FOREIGN KEY (model_profile_revision_id, organization_id)
        REFERENCES agent_controller.model_profile_revisions (id, organization_id)
);

ALTER TABLE agent_controller.agent_templates
    ADD CONSTRAINT template_head_fk
    FOREIGN KEY (id, organization_id, current_revision)
    REFERENCES agent_controller.agent_template_revisions (
        template_id, organization_id, revision
    )
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS agent_controller.agents (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (name <> ''),
    desired_state TEXT NOT NULL CHECK (desired_state IN ('enabled', 'disabled', 'deleted')),
    lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN (
        'provisioning', 'available', 'unavailable', 'disabled', 'deleting', 'deleted'
    )),
    access_revision TEXT NOT NULL,
    executable_spec_revision_id TEXT NOT NULL DEFAULT '',
    executable_execution_revision_id TEXT NOT NULL DEFAULT '',
    last_successful_execution_revision_id TEXT NOT NULL DEFAULT '',
    runtime_revision TEXT NOT NULL DEFAULT '',
    runtime_execution_id TEXT NOT NULL DEFAULT '',
    runtime_mcp_endpoint TEXT NOT NULL DEFAULT '',
    active_operation_request_id TEXT NOT NULL DEFAULT '',
    failure_stage TEXT NOT NULL DEFAULT '',
    failure_code TEXT NOT NULL DEFAULT '',
    failure_detail TEXT NOT NULL DEFAULT '',
    aggregate_sequence BIGINT NOT NULL DEFAULT 0 CHECK (aggregate_sequence >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS agents_projection_idx
    ON agent_controller.agents (organization_id, owner_user_id, created_at, id);

CREATE INDEX IF NOT EXISTS agents_organization_projection_idx
    ON agent_controller.agents (organization_id, created_at, id);

CREATE INDEX IF NOT EXISTS agents_owner_projection_idx
    ON agent_controller.agents (owner_user_id, created_at, id);

CREATE INDEX IF NOT EXISTS agents_state_projection_idx
    ON agent_controller.agents (lifecycle_state, created_at, id);

CREATE INDEX IF NOT EXISTS agents_global_projection_idx
    ON agent_controller.agents (created_at, id);

CREATE TABLE IF NOT EXISTS agent_controller.agent_spec_revisions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent_controller.agents(id),
    revision BIGINT NOT NULL CHECK (revision > 0),
    template_id TEXT NOT NULL,
    template_revision BIGINT NOT NULL CHECK (template_revision > 0),
    model_profile_revision_id TEXT NOT NULL,
    canonical_digest TEXT NOT NULL CHECK (canonical_digest ~ '^[0-9a-f]{64}$'),
    snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (agent_id, revision),
    UNIQUE (agent_id, id)
);

CREATE TABLE IF NOT EXISTS agent_controller.execution_revisions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent_controller.agents(id),
    revision BIGINT NOT NULL CHECK (revision > 0),
    agent_spec_revision_id TEXT NOT NULL,
    runtime_revision TEXT NOT NULL,
    runtime_execution_id TEXT NOT NULL,
    runtime_mcp_endpoint TEXT NOT NULL,
    runtime_mcp_source_digest TEXT NOT NULL CHECK (runtime_mcp_source_digest ~ '^[0-9a-f]{64}$'),
    change_summary JSONB NOT NULL,
    published_at TIMESTAMPTZ NOT NULL,
    UNIQUE (agent_id, revision),
    FOREIGN KEY (agent_id, agent_spec_revision_id)
        REFERENCES agent_controller.agent_spec_revisions(agent_id, id)
);

CREATE TABLE IF NOT EXISTS agent_controller.agent_access_bindings (
    access_subject TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent_controller.agents(id),
    principal_id TEXT NOT NULL,
    access_revision TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    prompt_image BOOLEAN NOT NULL DEFAULT FALSE,
    prompt_embedded_context BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS access_bindings_agent_idx
    ON agent_controller.agent_access_bindings (agent_id, principal_id);

CREATE TABLE IF NOT EXISTS agent_controller.agent_lifecycle_operations (
    request_id TEXT PRIMARY KEY,
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    agent_id TEXT NOT NULL REFERENCES agent_controller.agents(id),
    kind TEXT NOT NULL CHECK (kind IN ('create', 'rebuild', 'disable', 'enable', 'delete')),
    phase TEXT NOT NULL CHECK (phase IN (
        'drain', 'network_ensure', 'network_fence',
        'runtime_initialize', 'runtime_update', 'runtime_disable',
        'runtime_enable', 'runtime_delete', 'network_release', 'network_restore',
        'publish', 'completed'
    )),
    state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
    CHECK (
        phase = 'completed'
        OR (kind = 'create' AND phase IN (
            'network_ensure', 'runtime_initialize', 'publish'
        ))
        OR (kind = 'rebuild' AND phase IN (
            'drain', 'network_fence', 'runtime_update',
            'network_ensure', 'publish'
        ))
        OR (kind = 'disable' AND phase IN (
            'drain', 'network_fence', 'runtime_disable', 'publish'
        ))
        OR (kind = 'enable' AND phase IN (
            'network_ensure', 'runtime_enable', 'network_restore', 'publish'
        ))
        OR (kind = 'delete' AND phase IN (
            'drain', 'network_fence', 'runtime_delete',
            'network_release', 'publish'
        ))
    ),
    CHECK (
        (state = 'completed' AND phase = 'completed')
        OR (state IN ('running', 'failed') AND phase <> 'completed')
    ),
    source_spec_revision_id TEXT NOT NULL DEFAULT '',
    source_execution_revision_id TEXT NOT NULL DEFAULT '',
    source_runtime_revision TEXT NOT NULL DEFAULT '',
    source_runtime_absent BOOLEAN NOT NULL DEFAULT FALSE,
    target_spec_revision_id TEXT NOT NULL DEFAULT '',
    child_request_id TEXT NOT NULL DEFAULT '',
    network_attachment JSONB,
    source_runtime_inspection JSONB,
    source_runtime_absence_proof JSONB,
    runtime_result JSONB,
    network_release_outcome TEXT NOT NULL DEFAULT '' CHECK (
        network_release_outcome IN ('', 'quarantined', 'authoritative_absent')
    ),
    initial_attempt_trace_parent TEXT NOT NULL DEFAULT '',
    previous_recovery_trace_parent TEXT NOT NULL DEFAULT '',
    attempt BIGINT NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    recovery_owner TEXT NOT NULL DEFAULT '',
    recovery_lease_until TIMESTAMPTZ,
    recovery_after TIMESTAMPTZ NOT NULL,
    recovery_failure_count BIGINT NOT NULL DEFAULT 0 CHECK (recovery_failure_count >= 0),
    error_code TEXT NOT NULL DEFAULT '',
    error_detail TEXT NOT NULL DEFAULT '',
    retryable BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT agent_lifecycle_operations_recovery_pair_check CHECK (
        (recovery_owner = '' AND recovery_lease_until IS NULL) OR
        (recovery_owner <> '' AND recovery_lease_until IS NOT NULL)
    ),
    CONSTRAINT agent_lifecycle_operations_terminal_unclaimed_check CHECK (
        state = 'running' OR
        (recovery_owner = '' AND recovery_lease_until IS NULL)
    ),
    CHECK (
        (kind = 'create' AND source_spec_revision_id = '' AND source_execution_revision_id = ''
            AND source_runtime_revision = ''
            AND NOT source_runtime_absent AND target_spec_revision_id <> '') OR
        (kind = 'rebuild' AND source_spec_revision_id <> '' AND source_execution_revision_id <> ''
            AND source_runtime_revision <> ''
            AND NOT source_runtime_absent AND target_spec_revision_id <> '') OR
        (kind = 'disable' AND source_spec_revision_id <> '' AND source_execution_revision_id <> ''
            AND source_runtime_revision <> ''
            AND NOT source_runtime_absent AND target_spec_revision_id = '') OR
        (kind = 'enable' AND source_spec_revision_id <> '' AND source_execution_revision_id <> ''
            AND source_runtime_revision <> ''
            AND NOT source_runtime_absent AND target_spec_revision_id <> '') OR
        (kind = 'delete' AND source_spec_revision_id = ''
            AND source_execution_revision_id = '' AND target_spec_revision_id = '' AND (
            (source_runtime_revision <> '' AND NOT source_runtime_absent) OR
            (source_runtime_revision = '' AND source_spec_revision_id = ''
                AND source_execution_revision_id = '' AND source_runtime_absent)
        ))
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS operations_agent_nonterminal_unique
    ON agent_controller.agent_lifecycle_operations (agent_id)
    WHERE state = 'running';

CREATE INDEX IF NOT EXISTS operations_recovery_claim_idx
    ON agent_controller.agent_lifecycle_operations (
        recovery_after, updated_at, request_id
    )
    WHERE state = 'running';

CREATE TABLE IF NOT EXISTS agent_controller.run_admissions (
    admission_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    agent_id TEXT NOT NULL REFERENCES agent_controller.agents(id),
    session_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    access_revision TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'released', 'blocked_unknown_effect')),
    deadline TIMESTAMPTZ NOT NULL,
    runtime_revision TEXT NOT NULL,
    snapshot JSONB NOT NULL,
    terminal_report JSONB,
    finished_at TIMESTAMPTZ,
    released_by_operation_request_id TEXT NOT NULL DEFAULT '',
    released_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK (deadline > created_at),
    CHECK (jsonb_typeof(snapshot) = 'object'),
    CHECK (
        snapshot #>> '{runtime,runtime_revision}' IS NOT NULL AND
        snapshot #>> '{runtime,runtime_revision}' = runtime_revision
    ),
    CHECK (
        (state = 'active' AND terminal_report IS NULL AND finished_at IS NULL
            AND released_at IS NULL AND released_by_operation_request_id = '') OR
        (state = 'blocked_unknown_effect' AND terminal_report IS NOT NULL
            AND finished_at IS NOT NULL AND released_at IS NULL
            AND released_by_operation_request_id = '') OR
        (state = 'released' AND terminal_report IS NOT NULL
            AND finished_at IS NOT NULL AND released_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS admissions_agent_occupancy_unique
    ON agent_controller.run_admissions (agent_id)
    WHERE state IN ('active', 'blocked_unknown_effect');

CREATE TABLE IF NOT EXISTS agent_controller.runtime_observation_cursor (
    singleton BOOLEAN PRIMARY KEY,
    last_sequence BIGINT NOT NULL CHECK (last_sequence >= 0),
    initialized BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT runtime_observation_cursor_singleton CHECK (singleton)
);

INSERT INTO agent_controller.runtime_observation_cursor (
    singleton, last_sequence, initialized
) VALUES (TRUE, 0, FALSE)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS agent_controller.event_journal_cursor (
    singleton BOOLEAN PRIMARY KEY,
    last_sequence BIGINT NOT NULL CHECK (last_sequence >= 0),
    CONSTRAINT event_journal_cursor_singleton CHECK (singleton)
);

INSERT INTO agent_controller.event_journal_cursor (singleton, last_sequence)
VALUES (TRUE, 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS agent_controller.agent_events (
    global_sequence BIGINT PRIMARY KEY CHECK (global_sequence > 0),
    event_id TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL REFERENCES agent_controller.agents(id),
    aggregate_sequence BIGINT NOT NULL CHECK (aggregate_sequence > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    event_type TEXT NOT NULL,
    operation_request_id TEXT NOT NULL DEFAULT '',
    admission_id TEXT NOT NULL DEFAULT '',
    trace_id TEXT NOT NULL DEFAULT '',
    data JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT agent_events_type_known CHECK (event_type IN (
        'agent_create_requested', 'agent_ready', 'agent_build_failed',
        'agent_rebuild_requested', 'agent_rebuilt',
        'agent_disable_requested', 'agent_disabled', 'agent_disable_failed',
        'agent_enable_requested', 'agent_enabled', 'agent_enable_failed',
		'agent_delete_requested', 'agent_deleted',
		'agent_lifecycle_quarantined', 'agent_runtime_restarted',
        'run_admission_released', 'run_admission_unresolved'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_events_aggregate_sequence_unique
    ON agent_controller.agent_events (agent_id, aggregate_sequence);

CREATE INDEX IF NOT EXISTS agent_events_global_replay_idx
    ON agent_controller.agent_events (global_sequence);

CREATE OR REPLACE FUNCTION agent_controller.notify_agent_event_commit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('agent_controller_events', NEW.global_sequence::TEXT);
    RETURN NEW;
END;
$$;

CREATE TRIGGER agent_events_notify_commit
AFTER INSERT ON agent_controller.agent_events
FOR EACH ROW EXECUTE FUNCTION agent_controller.notify_agent_event_commit();
