export type AuditPage<T> = { items: T[]; next_cursor: string | null };

export type ExecutionAuditSummary = {
  run_id: string;
  session_id: string;
  agent_id: string;
  principal_id: string;
  state: string;
  created_at: string;
  updated_at: string;
};

export type ExecutionAuditDetail = ExecutionAuditSummary & {
  input: unknown;
  execution_snapshot: unknown;
  terminal_class: string | null;
  executor_state: string | null;
  tool_effect_state: string | null;
  stop_reason: string | null;
  error_class: string | null;
  unknown_effect_source?: string | null;
  usage_measurements: unknown[];
};

export type ExecutionAuditEvent = {
  id: string;
  sequence: number;
  kind: string;
  visible: boolean;
  payload: unknown;
  created_at: string;
};

export type ExecutionAuditPermission = {
  tool_call_id: string;
  request: unknown;
  decision: string | null;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
};

export type AuditFilters = {
  agent_id?: string;
  session_id?: string;
  created_from?: string;
  created_until?: string;
};

export function auditQuery(
  fields: AuditFilters & { stream?: string; cursor?: string },
): string {
  const query = new URLSearchParams({ limit: "50" });
  for (const [name, value] of Object.entries(fields)) {
    if (value) query.set(name, value);
  }
  return query.toString();
}
