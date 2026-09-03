export type Principal = {
  user_id: string;
  organization_id: string;
  membership_id: string;
  system_role: string;
  organization_role: string;
  active: boolean;
};

export type Session = { principal: Principal; expires_at?: string };

export type CurrentAccount = {
  email: string;
  display_name: string;
  source: "local" | "scim";
  organization_slug: string;
  organization_name: string;
  local_password_available: boolean;
};

export type CurrentAccountResult = { account: CurrentAccount };

export type LoginMethod = {
  name: string;
  display_name: string;
};

export type LoginMethodList = { methods: LoginMethod[] };

export type OIDCLoginStart = {
  authorization_url: string;
  expires_at: string;
};

export type DirectoryUser = {
  id: string;
  system_role: string;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type DirectoryMembership = {
  id: string;
  user_id: string;
  email: string;
  display_name: string;
  role: "member" | "admin";
  source: "local" | "scim";
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type DirectoryMember = {
  user: DirectoryUser;
  membership: DirectoryMembership;
};

export type DirectoryGroup = {
  display_name: string;
  source: "local" | "scim";
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type Directory = {
  users: DirectoryMember[];
  groups: DirectoryGroup[];
};

export type OIDCProvider = {
  name: string;
  display_name: string;
  issuer: string;
  client_id: string;
  scopes: string[];
  enabled: boolean;
  revision: number;
  authorization_endpoint: string;
  token_endpoint: string;
  token_endpoint_auth_method: string;
  id_token_signing_algs: string[];
  userinfo_endpoint?: string;
  jwks_uri: string;
  created_at: string;
  updated_at: string;
};

export type OIDCProviderList = { providers: OIDCProvider[] };
export type OIDCProviderResult = { provider: OIDCProvider };

export type SCIMToken = {
  id: string;
  name: string;
  scopes: Array<"scim:read" | "scim:write">;
  created_at: string;
  revoked_at?: string;
};

export type SCIMTokenList = { tokens: SCIMToken[] };
export type SCIMTokenIssue = { token: SCIMToken; credential: string };

export type ModelSpec = {
  base_url: string;
  model: string;
  context_window: number;
  max_output_tokens: number;
  temperature?: number;
  supports_images: boolean;
};

export type ModelCatalogEntry = {
  model_id: string;
  display_name: string;
  context_window: number;
  max_output_tokens: number;
  supports_images: boolean;
};

export type ModelProviderPreset = {
  provider_key: string;
  display_name: string;
  description: string;
  base_url: string;
  custom: boolean;
  models: ModelCatalogEntry[];
};

export type ModelCatalog = {
  revision: string;
  providers: ModelProviderPreset[];
};

export type ModelProfile = {
  model_profile_id: string;
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

export type TemplateDefaults = {
  runtime_image_ref: string;
};

export type Agent = {
  agent_id: string;
  owner_user_id: string;
  name: string;
  desired_state: string;
  lifecycle_state: string;
  executable_execution_revision?: string;
  configuration?: {
    template: {
      template_id: string;
      revision: number;
      name: string;
    };
    model_profile: {
      model_profile_id: string;
      revision_id: string;
      revision: number;
      name: string;
      model: ModelSpec;
    };
    max_model_requests: number;
    context_policy_version: string;
    runtime: RuntimeSpec;
  };
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
