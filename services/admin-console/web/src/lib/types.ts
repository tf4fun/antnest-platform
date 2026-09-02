export type Principal = {
  user_id: string;
  organization_id: string;
  membership_id: string;
  system_role: string;
  organization_role: string;
  active: boolean;
};

export type Session = { principal: Principal; expires_at?: string };

export type DirectoryMember = {
  user: {
    id: string;
    system_role: string;
    active: boolean;
    created_at: string;
    updated_at: string;
  };
  membership: {
    id: string;
    organization_id: string;
    user_id: string;
    email: string;
    display_name: string;
    role: string;
    source: string;
    active: boolean;
    created_at: string;
    updated_at: string;
  };
};

export type Directory = {
  users: DirectoryMember[];
  groups: Array<{ id: string; display_name: string; active: boolean }>;
};

export type ModelSpec = {
  base_url: string;
  model: string;
  context_window: number;
  max_output_tokens: number;
  temperature?: number;
  supports_images: boolean;
};

export type ModelProfile = {
  model_profile_id: string;
  organization_id: string;
  profile_key: string;
  display_name: string;
  revision_id: string;
  revision: number;
  enabled: boolean;
  model: ModelSpec;
  created_at: string;
  updated_at: string;
};

export type ModelProfileList = {
  items: ModelProfile[];
  next_after_id?: string | null;
};

export type RuntimeSpec = {
  image_ref: string;
  resources: { memory_bytes: number; pids_limit: number; tmpfs_bytes: number };
};

export type AgentTemplate = {
  template_id: string;
  organization_id: string;
  template_key: string;
  name: string;
  revision: number;
  model_profile_revision_id: string;
  system_prompt: string;
  max_model_requests: number;
  context_policy_version: string;
  runtime: RuntimeSpec;
  skill_refs: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type TemplateList = {
  items: AgentTemplate[];
  next_after_id?: string | null;
};

export type Agent = {
  agent_id: string;
  organization_id: string;
  owner_user_id: string;
  name: string;
  desired_state: string;
  lifecycle_state: string;
  executable_execution_revision?: string;
  runtime?: {
    runtime_revision: string;
  };
  active_operation_request_id?: string;
  failure_stage?: string;
  failure_code?: string;
  aggregate_sequence: number;
  created_at: string;
  updated_at: string;
};

export type AgentList = { items: Agent[]; next_cursor?: string | null };

export type LifecycleOperation = {
  request_id: string;
  agent_id: string;
  kind: string;
  phase: string;
  state: string;
  error_code?: string;
  error_detail?: string;
  created_at: string;
  updated_at: string;
};

export type CreateAgentResult = {
  agent: Agent;
  operation: LifecycleOperation;
};

export type AgentEvent = {
  event_id: string;
  global_sequence: number;
  aggregate_sequence: number;
  schema_version: number;
  agent_id: string;
  event_type: string;
  operation_request_id?: string;
  admission_id?: string;
  trace_id?: string;
  occurred_at: string;
};

export type AgentEventList = { events: AgentEvent[]; next_sequence: number };

export type OverviewSection<T> =
  | { status: "available"; data: T }
  | { status: "unavailable"; error: { code: string; message: string } };

export type Overview = {
  directory: OverviewSection<Directory>;
  model_profiles: OverviewSection<ModelProfileList>;
  templates: OverviewSection<TemplateList>;
  agents: OverviewSection<AgentList>;
  defaults: { runtime_image_ref: string };
};

export type RemoteErrorBody = {
  code?: string;
  message?: string;
  retryable?: boolean;
};
