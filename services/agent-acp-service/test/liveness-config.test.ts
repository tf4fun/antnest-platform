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

describe("connection liveness startup configuration", () => {
  it("defaults the ping interval to 20s and the approval deadline to 10m", () => {
    const config = configure();
    expect(config.wsPingIntervalMs).toBe(20_000);
    expect(config.runTimeoutMs).toBe(1_800_000);
    expect(config.permissionTimeoutMs).toBe(600_000);
  });
  it("falls back to half a shorter Run timeout for the approval deadline", () => {
    expect(configure({ ANTNEST_ACP_RUN_TIMEOUT: "60s" }).permissionTimeoutMs).toBe(30_000);
    expect(configure({ ANTNEST_ACP_RUN_TIMEOUT: "1500ms" }).permissionTimeoutMs).toBe(750);
  });
  it("reads explicit bounded liveness and approval durations", () => {
    const config = configure({
      ANTNEST_ACP_WS_PING_INTERVAL: "250ms",
      ANTNEST_ACP_PERMISSION_TIMEOUT: "45s",
    });
    expect(config.wsPingIntervalMs).toBe(250);
    expect(config.permissionTimeoutMs).toBe(45_000);
  });
  for (const value of [
    "",
    " ",
    "0ms",
    "0s",
    "-1s",
    "1.5s",
    "301s",
    "6m",
    "abc",
    "Infinity",
    "NaN",
  ]) {
    it(`rejects ANTNEST_ACP_WS_PING_INTERVAL=${JSON.stringify(value)} before serving`, () => {
      expect(() => configure({ ANTNEST_ACP_WS_PING_INTERVAL: value })).toThrow(ConfigError);
    });
  }
  for (const value of ["", " ", "0ms", "0s", "-1s", "1.5s", "abc", "Infinity", "NaN", "60000m"]) {
    it(`rejects ANTNEST_ACP_PERMISSION_TIMEOUT=${JSON.stringify(value)} before serving`, () => {
      expect(() => configure({ ANTNEST_ACP_PERMISSION_TIMEOUT: value })).toThrow(ConfigError);
    });
  }
  it("rejects an approval deadline equal to or longer than the Run timeout", () => {
    expect(() =>
      configure({ ANTNEST_ACP_RUN_TIMEOUT: "10m", ANTNEST_ACP_PERMISSION_TIMEOUT: "10m" }),
    ).toThrow(ConfigError);
    expect(() =>
      configure({ ANTNEST_ACP_RUN_TIMEOUT: "10m", ANTNEST_ACP_PERMISSION_TIMEOUT: "20m" }),
    ).toThrow(ConfigError);
    expect(() =>
      configure({ ANTNEST_ACP_RUN_TIMEOUT: "30s", ANTNEST_ACP_PERMISSION_TIMEOUT: "30000ms" }),
    ).toThrow(ConfigError);
  });
  it("rejects a Run timeout too small for any positive approval deadline", () => {
    expect(() => configure({ ANTNEST_ACP_RUN_TIMEOUT: "1ms" })).toThrow(ConfigError);
  });
});
