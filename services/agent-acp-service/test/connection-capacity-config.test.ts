import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type AgentAcpConfig } from "../src/config.js";
import { testSecurityEnvironment } from "./support/auth-fixture.js";

const loaded: AgentAcpConfig[] = [];
afterEach(async () => {
  for (const config of loaded.splice(0)) await config.authentication.workload.close();
});
function configure(overrides: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({
    ...testSecurityEnvironment(),
    ANTNEST_ACP_DATABASE_URL: "postgres://agent:secret@postgres/agent_acp",
    ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
    ...overrides,
  });
  loaded.push(config);
  return config;
}

describe("connection capacity startup configuration", () => {
  it("defaults to the frozen process, organization and principal limits", () => {
    expect(configure().connectionLimits).toStrictEqual({
      global: 1024,
      organization: 256,
      principal: 64,
    });
  });
  it("reads all three operator settings and permits equal bounds", () => {
    expect(
      configure({
        ANTNEST_ACP_MAX_CONNECTIONS: "20",
        ANTNEST_ACP_MAX_CONNECTIONS_PER_ORG: "8",
        ANTNEST_ACP_MAX_CONNECTIONS_PER_PRINCIPAL: "3",
      }).connectionLimits,
    ).toStrictEqual({ global: 20, organization: 8, principal: 3 });
    expect(
      configure({
        ANTNEST_ACP_MAX_CONNECTIONS: "1",
        ANTNEST_ACP_MAX_CONNECTIONS_PER_ORG: "1",
        ANTNEST_ACP_MAX_CONNECTIONS_PER_PRINCIPAL: "1",
      }).connectionLimits,
    ).toStrictEqual({ global: 1, organization: 1, principal: 1 });
  });
  for (const key of [
    "ANTNEST_ACP_MAX_CONNECTIONS",
    "ANTNEST_ACP_MAX_CONNECTIONS_PER_ORG",
    "ANTNEST_ACP_MAX_CONNECTIONS_PER_PRINCIPAL",
  ]) {
    for (const value of ["", " ", "0", "-1", "1.5", "NaN", "Infinity", "1e3", "9007199254740992"]) {
      it(`rejects ${key}=${JSON.stringify(value)} before serving`, () => {
        expect(() => configure({ [key]: value })).toThrow(ConfigError);
      });
    }
  }
  it("rejects organization above the process limit or principal above the organization", () => {
    expect(() => configure({ ANTNEST_ACP_MAX_CONNECTIONS: "128" })).toThrow(ConfigError);
    expect(() => configure({ ANTNEST_ACP_MAX_CONNECTIONS_PER_PRINCIPAL: "257" })).toThrow(
      ConfigError,
    );
  });
});
