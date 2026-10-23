import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type AgentAcpConfig } from "../src/config.js";
import { testSecurityEnvironment } from "./support/auth-fixture.js";

const enabled = {
  ANTNEST_ACP_OWNER_MEMBER_ID: "acp-a",
  ANTNEST_ACP_OWNER_LISTEN: "127.0.0.1:8085",
  ANTNEST_ACP_RUNTIME_CONTROLLER_URL: "http://runtime-controller:8080",
};

function environment(patch: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...testSecurityEnvironment(),
    ANTNEST_ACP_DATABASE_URL: "postgres://agent:secret@postgres/agent_acp",
    ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
    ...patch,
  };
}

async function withConfig(patch: NodeJS.ProcessEnv, check: (config: AgentAcpConfig) => void) {
  const config = loadConfig(environment(patch));
  try {
    check(config);
  } finally {
    await config.authentication.workload.close();
  }
}

async function rejects(patch: NodeJS.ProcessEnv) {
  let config: AgentAcpConfig | undefined;
  let failure: unknown;
  try {
    config = loadConfig(environment(patch));
  } catch (error) {
    failure = error;
  } finally {
    await config?.authentication.workload.close();
  }
  expect(failure).toBeInstanceOf(ConfigError);
  expect((failure as Error).message).not.toContain("PRIVATE_OWNER_ADDRESS");
}

describe("owner incarnation startup configuration", () => {
  it("keeps registration disabled until the operator configures the complete member group", async () => {
    await withConfig({}, (config) => expect(config.ownerIncarnation).toBeUndefined());
  });

  it("loads an independent private listener, exact member and RC origin with a finite startup budget", async () => {
    await withConfig(enabled, (config) => {
      expect(config.ownerIncarnation).toEqual({
        memberId: "acp-a",
        listen: { host: "127.0.0.1", port: 8085 },
        runtimeControllerUrl: "http://runtime-controller:8080/",
        registrationTimeoutMs: 30_000,
      });
      expect(config.controlListen.port).toBe(8081);
      expect(config.listen.port).toBe(8080);
    });
  });

  it("supports explicit IPv6 and a bounded operator startup timeout", async () => {
    await withConfig(
      {
        ...enabled,
        ANTNEST_ACP_OWNER_LISTEN: "[::1]:8085",
        ANTNEST_ACP_OWNER_REGISTRATION_TIMEOUT: "45s",
      },
      (config) => {
        expect(config.ownerIncarnation?.listen).toEqual({ host: "::1", port: 8085 });
        expect(config.ownerIncarnation?.registrationTimeoutMs).toBe(45_000);
      },
    );
  });

  it.each(Object.keys(enabled))("rejects a partially configured group missing %s", async (key) => {
    await rejects({ ...enabled, [key]: undefined });
  });

  it("rejects a registration budget without an enabled member", async () => {
    await rejects({ ANTNEST_ACP_OWNER_REGISTRATION_TIMEOUT: "30s" });
  });

  it.each([
    "",
    " Acp-a",
    "ACP-a",
    "acp_a",
    "-a",
    "a-",
    "a".repeat(65),
    "acp-a\n",
    "acp-a\r",
    "acp-a\u2028",
    "acp-a\u2029",
  ])("rejects noncanonical member %j", async (member) =>
    rejects({ ...enabled, ANTNEST_ACP_OWNER_MEMBER_ID: member }),
  );

  it.each([
    ":8085",
    "0.0.0.0:8085",
    "[::]:8085",
    "224.0.0.1:8085",
    "[ff02::1]:8085",
    "255.255.255.255:8085",
    "owner.invalid:8085",
    "127.0.0.1:0",
    "127.0.0.1:65536",
    "127.0.0.1:8080",
    "127.0.0.1:8081",
  ])("rejects an unspecified, non-unicast or overlapping owner listener %s", async (listen) => {
    await rejects({ ...enabled, ANTNEST_ACP_OWNER_LISTEN: listen });
  });

  it.each([
    "http://PRIVATE_OWNER_ADDRESS/path",
    "http://PRIVATE_OWNER_ADDRESS/?x=1",
    "http://PRIVATE_OWNER_ADDRESS/#fragment",
    "http://user:secret@PRIVATE_OWNER_ADDRESS/",
    "file:///PRIVATE_OWNER_ADDRESS",
    "http://identity.invalid/",
    "not-an-origin",
    "http://PRIVATE_OWNER_ADDRESS:0/",
  ])("rejects a caller-unsafe or conflicting RC origin %s", async (origin) => {
    await rejects({ ...enabled, ANTNEST_ACP_RUNTIME_CONTROLLER_URL: origin });
  });

  it.each(["0s", "-1s", "121s", "Infinity", "1hour"])(
    "rejects nonpositive, malformed or excessive startup timeout %s",
    async (timeout) => rejects({ ...enabled, ANTNEST_ACP_OWNER_REGISTRATION_TIMEOUT: timeout }),
  );
});
