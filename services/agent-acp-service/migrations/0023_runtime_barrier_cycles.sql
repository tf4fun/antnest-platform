CREATE TABLE runtime_barrier_cycles (
  barrier_id text PRIMARY KEY CHECK (char_length(barrier_id) BETWEEN 1 AND 200),
  organization_id text NOT NULL CHECK (organization_id <> ''),
  agent_id text NOT NULL CHECK (agent_id <> ''),
  runtime_revision text NOT NULL CHECK (char_length(runtime_revision) BETWEEN 1 AND 200),
  runtime_execution_id text NOT NULL CHECK (char_length(runtime_execution_id) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

-- The revision identifies the protected binding. Endpoint and execution ID
-- changes within that revision must not replace its original cycle identity.
CREATE UNIQUE INDEX runtime_barrier_cycles_active_binding
  ON runtime_barrier_cycles (organization_id, agent_id, runtime_revision)
  WHERE retired_at IS NULL;

-- Legacy protection can span several Runs. Choose one deterministic original
-- snapshot as the anchor, but retain the whole tuple until every fact clears.
WITH protected_bindings AS (
  SELECT DISTINCT ON (
    session.organization_id,
    session.agent_id,
    run.execution_snapshot->'runtime'->>'revision'
  )
    session.organization_id,
    session.agent_id,
    run.execution_snapshot->'runtime'->>'revision' AS runtime_revision,
    run.execution_snapshot->'runtime'->>'executionId' AS runtime_execution_id
  FROM runs AS run
  JOIN acp_sessions AS session ON session.id = run.session_id
  WHERE run.state IN ('completed', 'cancelled', 'failed', 'unresolved')
    AND run.terminal_class = run.state
    AND run.executor_state = 'quiescent'
    -- Pre-configuration history may not contain a Runtime binding. Preserve
    -- those facts without inventing a revision or original execution identity.
    AND run.execution_snapshot->'runtime'->>'revision' ~ '^[^[:space:]]{1,200}$'
    AND run.execution_snapshot->'runtime'->>'executionId' ~ '^[^[:space:]]{1,200}$'
    AND (
      EXISTS (
        SELECT 1 FROM tool_attempts AS attempt
        WHERE attempt.run_id = run.id
          AND attempt.source = 'runtime' AND NOT attempt.runtime_call_stopped
      )
      OR EXISTS (
        SELECT 1 FROM temporary_skill_scopes AS temporary
        WHERE temporary.run_id = run.id AND temporary.released_at IS NULL
      )
    )
  ORDER BY session.organization_id, session.agent_id,
    run.execution_snapshot->'runtime'->>'revision', run.created_at, run.id
)
INSERT INTO runtime_barrier_cycles (
  barrier_id, organization_id, agent_id, runtime_revision, runtime_execution_id
)
SELECT gen_random_uuid()::text, organization_id, agent_id,
  runtime_revision, runtime_execution_id
FROM protected_bindings;
