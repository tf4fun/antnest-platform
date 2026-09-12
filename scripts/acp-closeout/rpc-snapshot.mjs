import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const snapshotHash = (value) =>
  hash({
    ...value,
    admission_deadline: new Date(value.admission_deadline).toISOString(),
  });
const rename = (value, names) =>
  Object.fromEntries(
    Object.entries(value).map(([key, item]) => [names[key] ?? key, item]),
  );

// The independent oracle maps persisted names back to the wire contract. It
// preserves unknown fields so a schema change cannot silently weaken coverage.
export function storedAdmission(snapshot) {
  const { clientMcpRevisionId: _clientOnly, ...admission } = snapshot;
  const result = rename(admission, {
    admissionId: "admission_id",
    admissionDeadline: "admission_deadline",
    agentSpecRevision: "agent_spec_revision",
    executionRevision: "execution_revision",
    runtimeMcpSourceDigest: "runtime_mcp_source_digest",
    agentExecutionSpecDigest: "agent_execution_spec_digest",
    credentialVersion: "credential_version",
    executionSpec: "execution_spec",
  });
  result.runtime = rename(result.runtime, {
    revision: "runtime_revision",
    executionId: "runtime_execution_id",
    mcpEndpoint: "mcp_endpoint",
  });
  const spec = rename(result.execution_spec, {
    systemPrompt: "system_prompt",
    contextPolicyVersion: "context_policy_version",
    skillInstructions: "skill_instructions",
    maxModelRequests: "max_model_requests",
    credentialRef: "credential_ref",
  });
  spec.skill_instructions = spec.skill_instructions.map((skill) =>
    rename(skill, { skillKey: "skill_key" }),
  );
  spec.model = rename(spec.model, {
    baseUrl: "base_url",
    contextWindow: "context_window",
    maxOutputTokens: "max_output_tokens",
    supportsImages: "supports_images",
    supportsAudio: "supports_audio",
    supportsPdf: "supports_pdf",
  });
  if (spec.model.pricing)
    spec.model.pricing = rename(spec.model.pricing, {
      inputPerMillion: "input_per_million",
      outputPerMillion: "output_per_million",
      cacheReadPerMillion: "cache_read_per_million",
      cacheWritePerMillion: "cache_write_per_million",
    });
  if (spec.configuration) {
    spec.configuration = rename(spec.configuration, {
      modelProfileId: "model_profile_id",
      modelProfileRevisionId: "model_profile_revision_id",
      authorizationRevision: "authorization_revision",
    });
    const authorization = rename(spec.configuration.authorization, {
      toolRules: "tool_rules",
    });
    authorization.tool_rules = authorization.tool_rules.map((rule) =>
      rename(rule, { sourceId: "source_id", toolName: "tool_name" }),
    );
    spec.configuration.authorization = authorization;
  }
  result.execution_spec = spec;
  return result;
}
