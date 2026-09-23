-- Operator-only acceptance query. Services never use another service's database.
BEGIN READ ONLY;
SELECT COALESCE(jsonb_agg(to_jsonb(binding)), '[]'::jsonb)
FROM (
    SELECT a.id AS agent_id, op.request_id,
           c.trace_id AS creation_trace_id, r.trace_id AS readiness_trace_id,
           e.id AS execution_revision, e.runtime_revision, e.runtime_execution_id,
           e.runtime_mcp_endpoint AS mcp_endpoint,
           (SELECT count(*) FROM agent_controller.execution_revisions WHERE agent_id = a.id) AS execution_count,
           (a.lifecycle_state = 'created' AND a.activation_state = 'enabled'
            AND a.runtime_state = 'available' AND a.desired_state = 'enabled'
            AND a.active_operation_request_id = ''
            AND a.executable_spec_revision_id = e.agent_spec_revision_id
            AND a.runtime_revision = e.runtime_revision
            AND a.runtime_execution_id = e.runtime_execution_id
            AND a.runtime_mcp_endpoint = e.runtime_mcp_endpoint
            AND e.runtime_execution_id <> '' AND e.runtime_mcp_endpoint <> ''
            AND op.state = 'completed' AND op.target_spec_revision_id = e.agent_spec_revision_id
            AND op.runtime_result->>'runtime_revision' = e.runtime_revision
            AND r.data->>'execution_revision_id' = e.id
            AND r.data->>'agent_spec_revision_id' = e.agent_spec_revision_id
            AND r.data->>'runtime_revision' = e.runtime_revision
            AND r.occurred_at = e.published_at AND r.occurred_at >= c.occurred_at
            AND r.aggregate_sequence > c.aggregate_sequence) AS binding_coherent,
           (op.runtime_result->>'state' = 'completed'
            AND op.runtime_result->>'effect' = 'completed'
            AND op.runtime_result->>'lifecycle_state' = 'provisioned'
            AND op.runtime_result->>'health' = 'unknown'
            AND COALESCE(op.runtime_result->>'runtime_execution_id', '') = ''
            AND COALESCE(op.runtime_result->>'mcp_endpoint', '') = '') AS creation_unbound
    FROM agent_controller.agents a
    JOIN agent_controller.execution_revisions e
      ON e.agent_id = a.id AND e.id = a.executable_execution_revision_id
    JOIN agent_controller.agent_events r ON r.agent_id = a.id AND r.event_type = 'agent_ready'
    JOIN agent_controller.agent_events c ON c.agent_id = a.id AND c.event_type = 'agent_created'
      AND c.operation_request_id = r.operation_request_id
    JOIN agent_controller.agent_lifecycle_operations op ON op.agent_id = a.id
      AND op.request_id = r.operation_request_id AND op.kind = 'create'
    WHERE a.id = :'agent_id'
) binding;
COMMIT;
