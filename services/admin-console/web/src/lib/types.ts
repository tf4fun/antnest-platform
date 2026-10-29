export type Principal = {
  user_id: string;
  organization_id: string;
  organization_slug: string;
  organization_name: string;
  membership_id: string;
  system_role: string;
  organization_role: string;
  active: boolean;
};

export type SessionMetadata = { expires_at: string; idle_expires_at: string; activity_interval_ms: number };
export type Session = SessionMetadata & { principal: Principal };

export type BrowserSession = {
  id: string;
  organization_id: string;
  organization_slug: string;
  organization_name: string;
  created_at: string;
  last_active_at: string;
  idle_expires_at: string;
  expires_at: string;
  user_agent_hint: string;
  current: boolean;
};
export type BrowserSessionPage = { sessions: BrowserSession[]; next_after_id?: string };
export type SessionRevocation = { revoked_count: number; current_revoked: boolean };

export type CurrentAccount = {
  user_id: string;
  organization_id: string;
  membership_id: string;
  email: string;
  display_name: string;
  source: "local" | "scim";
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

export type OIDCLinkPolicy = "none" | "verified_email_in_domains" | "verified_email";
export type OIDCPolicy = {
  link_policy: OIDCLinkPolicy;
  link_domains: string[];
  authoritative: boolean;
};

export type ExternalIdentityProvider = OIDCPolicy & {
  id: string;
  name: string;
  display_name: string;
  enabled: boolean;
  link_policy_review_required: boolean;
};
export type ExternalIdentityProviderPage = { providers: ExternalIdentityProvider[]; next_after_id?: string };
export type ExternalIdentityDetails = {
  id: string;
  provider_id: string;
  provider_name: string;
  provider_display_name: string;
  organization_id: string;
  organization_slug: string;
  organization_name: string;
  membership_id: string;
  subject: string;
  method: "auto" | "admin" | "scim";
  created_at: string;
};
export type ExternalIdentity = ExternalIdentityDetails & {
  provider_enabled: boolean;
  bound_at: string;
  revoked_at: string | null;
};
export type ExternalIdentityNotice = ExternalIdentityDetails & { binding_id: string };
export type ExternalIdentityPage = { bindings: ExternalIdentity[]; next_after_id?: string };
export type SelfExternalIdentityPage = ExternalIdentityPage & { notices: ExternalIdentityNotice[]; next_notice_after_id?: string };
export type ExternalIdentityBindInput = { provider_id: string; subject: string; restore_revoked?: boolean };

export type OIDCProvider = OIDCPolicy & {
  link_policy_review_required: boolean;
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
  expires_at: string;
  issued_by: string | null;
  issuer_review_required: boolean;
  oidc_provider_id: string | null;
  id: string;
  name: string;
  scopes: Array<"scim:read" | "scim:write">;
  created_at: string;
  revoked_at?: string;
};

export type SCIMTokenList = { tokens: SCIMToken[] };
export type SCIMTokenIssue = { token: SCIMToken; credential: string };

export type ModelPricing = {
  currency: "USD";
  input_per_million: number;
  output_per_million: number;
  cache_read_per_million?: number;
  cache_write_per_million?: number;
};

export type ModelSpec = {
  pricing?: ModelPricing;
  base_url: string;
  model: string;
  context_window: number;
  max_output_tokens: number;
  temperature?: number;
  supports_images: boolean;
  supports_audio?: boolean;
  supports_pdf?: boolean;
  tokenizer?: "o200k" | "cl100k" | "none";
  compaction_model_profile_id?: string;
};

export type ModelParameters = Omit<ModelSpec, "base_url">;
export type ProviderCredential = { method: "api_key"; api_key: string };
export type ProviderConnection = {
  connection_id: string;
  provider_key: string;
  display_name: string;
  base_url: string;
  credential_method: "api_key";
  credential_version: string;
  credential_revision: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};
export type ProviderConnectionList = { items: ProviderConnection[]; next_after_id?: string | null };
export type ProviderModelInput = { display_name: string; model: ModelParameters };

export type ModelCatalogEntry = {
  pricing?: ModelPricing;
  model_id: string;
  display_name: string;
  context_window: number;
  max_output_tokens: number;
  supports_images: boolean;
  supports_audio?: boolean;
  supports_pdf?: boolean;
};

export type DiscoveredModel = Pick<ModelCatalogEntry, "model_id" | "display_name"> & Partial<ModelCatalogEntry>;
export type ModelDiscovery = { models: DiscoveredModel[] };
export type ProviderDiscoveryDraft = {
  provider_key: string;
  base_url: string;
  credential: ProviderCredential;
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
  provider_connection_id: string;
  model_profile_id: string;
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

export type ManagedMCPSummary = { id: string; command: string };
export type ManagedMCPSecret = { set: true; fingerprint: string };
export type ManagedMCPSecretWrite = { value: string } | { keep: true };
export type ManagedMCPServer = ManagedMCPSummary & { args: string[]; env: Record<string, string>; secret_env?: Record<string, ManagedMCPSecret> };
export type ManagedMCPServerWrite = Omit<ManagedMCPServer, "secret_env"> & { secret_env?: Record<string, ManagedMCPSecretWrite> };

export type RuntimeSpec = {
  image_ref: string;
  image_source?: string;
  resources: { memory_bytes: number; pids_limit: number; tmpfs_bytes: number };
  mcp_servers?: ManagedMCPServer[];
};

export type AgentTemplate = {
	 fallback_model_profile_ids?: string[];
  template_id: string;
  name: string;
  revision: number;
  model_profile_id: string;
  system_prompt: string;
  max_model_requests: number;
  context_policy_version: string;
  runtime: RuntimeSpec;
  skill_refs: import("./skills").FrozenSkill[];
  skill_set_digest?: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  model_retry?: import("./model-call-policy").ModelRetry;
  failover?: "never" | "before_output";
  run_budget?: import("./model-call-policy").RunBudget;
};

export type TemplateList = {
  items: AgentTemplate[];
  next_after_id?: string | null;
};

export type TemplateDefaults = {
  runtime_image_ref: string;
};

export type RuntimeRecovery = {
  barrier_id: string;
  reason: "runtime_barrier_required";
  runtime_revision: string;
  policy_revision: number;
  mode: "manual" | "notify" | "auto";
  cooldown_ms: number;
  rebuild_request_id: string;
  notification_id: string;
  cooldown_until: string | null;
};

export type RuntimeRecoveryInput = {
  template_id: string;
  template_revision: number;
  recovery: { barrier_id: string; expected_runtime_revision: string };
};

export type Agent = {
  agent_id: string;
  owner_user_id: string;
  name: string;
  desired_state: string;
  lifecycle_state: string;
  activation_state?: string;
  readiness?: "preparing" | "ready" | "unavailable";
  runtime_state: string;
  runtime_reason?: string;
  runtime_detail?: string;
  runtime_observed_at?: string;
  runtime_recovery?: RuntimeRecovery;
  agent_spec_revision?: string;
  last_successful_execution_revision?: string;
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
    runtime: Omit<RuntimeSpec, "mcp_servers"> & { mcp_servers?: ManagedMCPSummary[] };
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

export type AgentSkillPreparation = {
  request_id: string;
  agent_id: string;
  kind: "create" | "rebuild" | "enable";
  state: "preparing" | "queued" | "retry_wait" | "paused" | "ready" | "rejected" | "invalidated" | "cleanup_pending" | "abandoned" | "released";
  progress: { verified_packages: number; verified_bytes: number; total_packages: number; total_bytes: number };
  retry_after?: string;
  error_code?: string;
  updated_at: string;
};

export type AgentEvent = {
  event_id: string;
  global_sequence: number;
  aggregate_sequence: number;
  schema_version: number;
  agent_id: string;
  event_type: string;
  operation_request_id?: string;
  trace_id?: string;
  occurred_at: string;
};

export type AgentEventList = { events: AgentEvent[]; next_sequence: number };

export type OverviewSection<T> =
  | { status: "available"; data: T }
  | { status: "unavailable"; error: { status: number; code: string; message: string } };

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
  references?: unknown;
  references_truncated?: unknown;
};
