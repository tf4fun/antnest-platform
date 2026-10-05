import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { testSecurityEnvironment } from "./support/auth-fixture.js";

function environment(): NodeJS.ProcessEnv {
  return {
    ...testSecurityEnvironment(),
    ANTNEST_ACP_DATABASE_URL: "postgres://acp:private@postgres/acp",
    ANTNEST_ACP_CLIENT_MCP_KEY: randomBytes(32).toString("base64"),
    ANTNEST_ALLOW_PUBLIC_DEV_SECRETS: "false",
  };
}

describe("public development secrets", () => {
  it.each([
    ["ANTNEST_ACP_CLIENT_MCP_KEY", Buffer.alloc(32).toString("base64")],
    ["ANTNEST_ACP_CLIENT_MCP_KEY", Buffer.alloc(32, 7).toString("base64")],
    ["ANTNEST_ACP_DATABASE_URL", "postgres://acp:antnest-agent-acp-dev@postgres/acp"],
    ["ANTNEST_ACP_DATABASE_URL", "postgres://acp:%61ntnest-agent-acp-dev@postgres/acp"],
    ["ANTNEST_ACP_DATABASE_URL", "postgres://acp@postgres/acp?password=antnest-agent-acp-dev"],
  ])("rejects published %s", (name, value) => {
    expect(() => loadConfig({ ...environment(), [name]: value })).toThrow(ConfigError);
    expect(() => loadConfig({ ...environment(), [name]: value })).toThrow(name);
  });
  const policy = JSON.parse(
    readFileSync(
      new URL("../../../contracts/platform/development-secrets.json", import.meta.url),
      "utf8",
    ),
  ) as { published_values: string[]; invalid_values: string[] };
  it.each(policy.published_values)("rejects every shared published value %s", (password) => {
    expect(() =>
      loadConfig({
        ...environment(),
        ANTNEST_ACP_DATABASE_URL: `postgres://acp:${password}@postgres/acp`,
      }),
    ).toThrow("ANTNEST_ACP_DATABASE_URL");
  });
  it.each(policy.invalid_values)("rejects non-exact opt-in %j", (value) => {
    expect(() => loadConfig({ ...environment(), ANTNEST_ALLOW_PUBLIC_DEV_SECRETS: value })).toThrow(
      "ANTNEST_ALLOW_PUBLIC_DEV_SECRETS",
    );
  });
  it("allows random keys without warnings and emits variable-only opt-in warnings", async () => {
    const clean = loadConfig(environment());
    expect(clean.developmentSecretWarnings).toEqual([]);
    await clean.authentication.workload.close();
    const values = {
      ...environment(),
      ANTNEST_ALLOW_PUBLIC_DEV_SECRETS: "true",
      ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.alloc(32).toString("base64"),
      ANTNEST_ACP_DATABASE_URL: "postgres://acp:antnest-agent-acp-dev@postgres/acp",
    };
    const config = loadConfig(values);
    expect(config.developmentSecretWarnings).toEqual([
      "ANTNEST_ACP_DATABASE_URL",
      "ANTNEST_ACP_CLIENT_MCP_KEY",
    ]);
    expect(config.allowDevelopmentSettings).toBe(false);
    expect(config.providerAllowPrivateEndpoints).toBe(false);
    await config.authentication.workload.close();
    expect(() =>
      loadConfig({ ...values, ANTNEST_ACP_SKILL_LEARNING_DEBUG_AGENT_ID: "debug-agent" }),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...values,
        ANTNEST_ACP_SKILL_REGISTRY_TOKEN: "antnest-skill-registry-local-development-token",
      }),
    ).toThrow();
  });
});
