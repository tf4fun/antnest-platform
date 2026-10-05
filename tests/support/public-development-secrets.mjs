// Published fixtures are for explicit disposable tests only. Standard operator
// deployments use scripts/generate-dev-env.sh and never import this helper.
export function publicDevelopmentSecrets() {
  return {
    ANTNEST_ALLOW_PUBLIC_DEV_SECRETS: "true",
    ANTNEST_POSTGRES_ADMIN_PASSWORD: "antnest-postgres-dev",
    ANTNEST_EGRESS_POSTGRES_PASSWORD: "antnest-egress-dev",
    ANTNEST_RUNTIME_CONTROLLER_POSTGRES_PASSWORD:
      "antnest-runtime-controller-dev",
    ANTNEST_AGENT_ACP_POSTGRES_PASSWORD: "antnest-agent-acp-dev",
    ANTNEST_IDENTITY_POSTGRES_PASSWORD: "antnest-identity-dev",
    ANTNEST_AGENT_CONTROLLER_POSTGRES_PASSWORD: "antnest-agent-controller-dev",
    ANTNEST_SKILL_REGISTRY_POSTGRES_PASSWORD: "antnest-skill-registry-dev",
    ANTNEST_TEMPORAL_POSTGRES_PASSWORD: "antnest-temporal-dev",
    ANTNEST_BOOTSTRAP_ADMIN_PASSWORD: "antnest-admin-dev",
    ANTNEST_IDENTITY_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY:
      Buffer.alloc(32).toString("base64"),
    ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.alloc(32).toString("base64"),
  };
}
