import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, type AgentAcpConfig } from "../src/config.js";
import { testSecurityEnvironment } from "./support/auth-fixture.js";

const owner = {
  ANTNEST_ACP_OWNER_MEMBER_ID: "acp-a",
  ANTNEST_ACP_OWNER_LISTEN: "127.0.0.1:8085",
  ANTNEST_ACP_RUNTIME_CONTROLLER_URL: "http://runtime-controller:8080",
};
const peer = {
  ANTNEST_ACP_PEER_LISTEN: "127.0.0.1:8086",
  ANTNEST_ACP_PEER_MEMBERSHIP_FILE: "/run/peer/members.json",
  ANTNEST_ACP_PEER_CALLERS_FILE: "/run/peer/callers.json",
  ANTNEST_ACP_PEER_TOKEN_DIRECTORY: "/run/peer/tokens",
};
async function check(patch: NodeJS.ProcessEnv, accept?: (config: AgentAcpConfig) => void) {
  let config: AgentAcpConfig | undefined;
  let failure: unknown;
  try {
    config = loadConfig({
      ...testSecurityEnvironment(),
      ANTNEST_ACP_DATABASE_URL: "postgres://agent:secret@postgres/agent_acp",
      ANTNEST_ACP_CLIENT_MCP_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString(
        "base64",
      ),
      ...owner,
      ...patch,
    });
  } catch (error) {
    failure = error;
  }
  try {
    if (accept) {
      expect(failure).toBeUndefined();
      accept(config!);
    } else {
      expect(failure).toBeInstanceOf(ConfigError);
      expect((failure as Error).message).not.toContain("PRIVATE_PEER_PATH");
    }
  } finally {
    await config?.authentication.workload.close();
  }
}

describe("peer bootstrap configuration", () => {
  it("leaves peer mode disabled when its complete group is absent", async () =>
    check({}, (config) => expect(config.peer).toBeUndefined()));
  it("loads a separate private listener and the complete member credential paths", async () =>
    check(peer, (config) =>
      expect(config.peer).toEqual({
        listen: { host: "127.0.0.1", port: 8086 },
        membershipFile: peer.ANTNEST_ACP_PEER_MEMBERSHIP_FILE,
        callersFile: peer.ANTNEST_ACP_PEER_CALLERS_FILE,
        tokenDirectory: peer.ANTNEST_ACP_PEER_TOKEN_DIRECTORY,
      }),
    ));
  it.each(Object.keys(peer))("rejects incomplete peer group without %s", async (key) =>
    check({ ...peer, [key]: undefined }),
  );
  it("requires registered owner mode", async () =>
    check({
      ...peer,
      ANTNEST_ACP_OWNER_MEMBER_ID: undefined,
      ANTNEST_ACP_OWNER_LISTEN: undefined,
      ANTNEST_ACP_RUNTIME_CONTROLLER_URL: undefined,
    }));
  it.each([
    "0.0.0.0:8086",
    "[::]:8086",
    "8.8.8.8:8086",
    "224.0.0.1:8086",
    "peer.invalid:8086",
    "127.0.0.1:0",
    "127.0.0.1:8080",
    "127.0.0.1:8081",
    "127.0.0.1:8085",
  ])("rejects public, unspecified, invalid or shared listener %s", async (listen) =>
    check({ ...peer, ANTNEST_ACP_PEER_LISTEN: listen }),
  );
  it.each(["", " PRIVATE_PEER_PATH", "PRIVATE_PEER_PATH\n", "PRIVATE_PEER_PATH\0"])(
    "rejects an empty or noncanonical credential path %j",
    async (path) => check({ ...peer, ANTNEST_ACP_PEER_MEMBERSHIP_FILE: path }),
  );
  it("accepts an explicit private IPv6 listener", async () =>
    check({ ...peer, ANTNEST_ACP_PEER_LISTEN: "[fd00::1]:8086" }, (config) =>
      expect(config.peer?.listen).toEqual({ host: "fd00::1", port: 8086 }),
    ));
});
