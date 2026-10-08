import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeConnections } from "../../src/adapters/runtime-connections.js";
import {
  parseExecutionConfiguration,
  publicExecutionConfiguration,
  resolveExecutionConfiguration,
} from "../../src/domain/execution-configuration.js";
import { executionConfiguration, executionIdentity } from "../fixtures/execution-configuration.js";

const transport = vi.hoisted(() => ({
  send: vi.fn<(url: string, options: RequestInit & { dispatcher: unknown }) => Promise<Response>>(),
  destroy: vi.fn(() => Promise.resolve()),
}));
vi.mock("undici", () => ({
  Agent: class {
    public destroy = transport.destroy;
  },
  fetch: transport.send,
}));

describe("volatile Runtime connections", () => {
  let connections: RuntimeConnections;
  beforeEach(() => {
    connections = new RuntimeConnections({ authMode: "token", allowInsecureTransport: "true" });
    transport.send.mockReset().mockImplementation(() => Promise.resolve(new Response("ok")));
    transport.destroy.mockClear();
  });
  afterEach(async () => {
    await connections.close();
  });
  function incoming() {
    return parseExecutionConfiguration(executionConfiguration());
  }
  function binding(configuration = incoming()) {
    return resolveExecutionConfiguration(
      publicExecutionConfiguration(configuration),
      executionIdentity(),
      {},
    ).runtime;
  }
  function file() {
    return join(connections.directory, binding().connectionId, "antnest-runtime");
  }
  function install(configuration = incoming()) {
    connections.prepare(configuration).commit();
    return binding(configuration);
  }
  function closed() {
    const configuration = incoming();
    configuration.revision++;
    const agent = configuration.agents[0]!;
    agent.accepting_runs = false;
    delete agent.runtime!.credential;
    delete agent.runtime!.connection_id;
    return configuration;
  }

  it("prepares 0700 directories and a private regular 0600 file without authorizing before commit", () => {
    const transaction = connections.prepare(incoming());
    expect(lstatSync(connections.directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(connections.directory, binding().connectionId)).mode & 0o777).toBe(0o700);
    expect(lstatSync(file()).isFile()).toBe(true);
    expect(lstatSync(file()).mode & 0o777).toBe(0o600);
    expect(lstatSync(file()).uid).toBe(process.getuid?.());
    expect(readFileSync(file(), "utf8")).toBe(incoming().agents[0]!.runtime!.credential!.token);
    expect(() => connections.fetchFor(binding())).toThrow("Runtime connection is unavailable");
    transaction.commit();
    expect(() => connections.fetchFor(binding())).not.toThrow();
  });
  it("rolls back staged files and authority", () => {
    connections.prepare(incoming()).rollback();
    expect(readdirSync(connections.directory)).toEqual([]);
    expect(() => connections.fetchFor(binding())).toThrow();
  });
  it("keeps immutable credential identity after a verified candidate is rolled back", () => {
    connections.prepare(incoming()).rollback();
    const replacement = incoming();
    replacement.agents[0]!.runtime!.credential!.token = Buffer.alloc(32, 7).toString("base64url");
    expect(() => connections.prepare(replacement)).toThrow(
      expect.objectContaining({ code: "configuration_conflict" }),
    );
    expect(readdirSync(connections.directory)).toEqual([]);
    install();
  });
  it("revokes only the failed organization's publication and preserves accepted authority", () => {
    const original = install();
    connections.retainRun("accepted-run", original);
    const other = incoming();
    other.agents[0]!.runtime!.connection_id = "rci_22222222222222222222222222222222";
    other.agents[0]!.runtime!.runtime_revision = "rtv_22222222222222222222222222222222";
    other.agents[0]!.runtime!.credential!.token = Buffer.alloc(32, 9).toString("base64url");
    const otherBinding = binding(other);
    other.organization_id = "organization-2";
    connections.prepare(other).commit();
    connections.revokePublication("organization-1");
    connections.revokePublication("organization-1");
    expect(() => connections.fetchFor(original)).not.toThrow();
    expect(() => connections.retainRun("later-run", original)).toThrow();
    expect(() => connections.fetchFor(otherBinding)).not.toThrow();
    connections.releaseRun("accepted-run");
    expect(() => connections.fetchFor(original)).toThrow();
    expect(() => connections.fetchFor(otherBinding)).not.toThrow();
  });
  it("retains accepted private operations through closure without allowing a new Run", async () => {
    const original = install();
    connections.retainOperation("install-1", original);
    connections.prepare(closed()).commit();
    expect(() => connections.retainRun("later-run", original)).toThrow();
    expect(() => connections.retainOperation("later-source-read", original)).toThrow();
    connections.retainOperation("cleanup-1", original, { cleanup: true });
    connections.releaseOperation("install-1");
    await connections.fetchFor(original)(
      new URL("/internal/skill-maintenance/install", original.mcpEndpoint),
      { method: "POST" },
    );
    expect(transport.send).toHaveBeenCalledTimes(1);
    connections.releaseOperation("cleanup-1");
    expect(() => connections.fetchFor(original)).toThrow();
    expect(existsSync(file())).toBe(false);
    expect(() => connections.retainOperation("cold-operation", original)).toThrow();
  });
  it("keeps Run and private-operation owners distinct and rejects operation retargeting", () => {
    const original = install();
    connections.retainRun("same-id", original);
    connections.retainOperation("same-id", original);
    expect(() =>
      connections.retainOperation("same-id", { ...original, executionId: "other" }),
    ).toThrow();
    connections.prepare(closed()).commit();
    connections.releaseRun("same-id");
    expect(() => connections.fetchFor(original)).not.toThrow();
    connections.releaseOperation("same-id");
    expect(() => connections.fetchFor(original)).toThrow();
  });
  it("resolves cleanup fences only to existing scoped authority, never to closure metadata", () => {
    const reference = binding();
    const fence = {
      organizationId: "organization-1",
      agentId: "agent-1",
      revision: reference.revision,
      executionId: reference.executionId,
      mcpEndpoint: reference.mcpEndpoint,
    };
    expect(connections.findForCleanup(fence)).toBeNull();
    install();
    expect(connections.findForCleanup(fence)).toEqual(reference);
    connections.retainRun("accepted-run", reference);
    connections.prepare(closed()).commit();
    const resolved = connections.findForCleanup(fence)!;
    expect(resolved).toEqual(reference);
    resolved.executionId = "do-not-mutate-authority";
    for (const mismatch of [
      { organizationId: "other-organization" },
      { agentId: "other-agent" },
      { revision: "rtv_22222222222222222222222222222222" },
      { executionId: "other-execution" },
      { mcpEndpoint: "http://other-runtime:8080/mcp" },
      { connectionId: "rci_22222222222222222222222222222222" },
    ])
      expect(connections.findForCleanup({ ...fence, ...mismatch })).toBeNull();
    expect(connections.findForCleanup({ ...fence, connectionId: reference.connectionId })).toEqual(
      reference,
    );
    connections.releaseRun("accepted-run");
    expect(connections.findForCleanup(fence)).toBeNull();
  });
  it.each([1, 2])(
    "rejects replacement credential bytes at configuration revision %i",
    (revision) => {
      install();
      const replacement = incoming();
      replacement.revision = revision;
      replacement.agents[0]!.runtime!.credential!.token = Buffer.alloc(32, 7).toString("base64url");
      expect(() => connections.prepare(replacement)).toThrow(
        expect.objectContaining({ code: "configuration_conflict" }),
      );
      expect(readFileSync(file(), "utf8")).toBe(incoming().agents[0]!.runtime!.credential!.token);
    },
  );
  it.each(["organization", "agent", "revision"])(
    "rejects reuse of an ID by another %s",
    (field) => {
      install();
      const replacement = incoming();
      if (field === "organization") replacement.organization_id = "other-organization";
      if (field === "agent") replacement.agents[0]!.agent_id = "other-agent";
      if (field === "revision")
        replacement.agents[0]!.runtime!.runtime_revision = "rtv_22222222222222222222222222222222";
      expect(() => connections.prepare(replacement)).toThrow(
        expect.objectContaining({ code: "configuration_conflict" }),
      );
    },
  );
  it("allows a verified process restart with the same generation credential", () => {
    const previous = install();
    const configuration = incoming();
    configuration.revision++;
    configuration.agents[0]!.runtime!.runtime_execution_id = "execution-after-restart";
    configuration.agents[0]!.runtime!.mcp_endpoint = "http://runtime-after-restart:8080/mcp";
    const current = install(configuration);
    expect(() => connections.fetchFor(current)).not.toThrow();
    expect(() => connections.fetchFor(previous)).toThrow();
    expect(readFileSync(file(), "utf8")).toBe(incoming().agents[0]!.runtime!.credential!.token);
  });
  it("retains closed authority only for accepted operations, then deletes obsolete instance files", () => {
    const original = install();
    connections.retainRun("accepted-run", original);
    connections.prepare(closed()).commit();
    expect(() => connections.fetchFor(original)).not.toThrow();
    expect(() => connections.retainRun("new-run", original)).toThrow();
    connections.releaseRun("accepted-run");
    expect(() => connections.fetchFor(original)).toThrow();
    expect(readdirSync(connections.directory)).toEqual([]);
  });
  it("cannot reconstruct authority from closed metadata after a cold restart", () => {
    connections.prepare(closed()).commit();
    expect(() => connections.fetchFor(binding())).toThrow();
    expect(readdirSync(connections.directory)).toEqual([]);
    install();
    expect(() => connections.fetchFor(binding())).not.toThrow();
  });
  it("retains immutable identity after its obsolete credential file is collected", () => {
    install();
    connections.prepare(closed()).commit();
    const replacement = incoming();
    replacement.agents[0]!.runtime!.credential!.token = Buffer.alloc(32, 7).toString("base64url");
    expect(() => connections.prepare(replacement)).toThrow(
      expect.objectContaining({ code: "configuration_conflict" }),
    );
    expect(readdirSync(connections.directory)).toEqual([]);
    install();
  });
  it("keeps retention of the same accepted operation idempotent after closure", () => {
    const reference = install();
    connections.retainRun("accepted-run", reference);
    connections.prepare(closed()).commit();
    expect(() => connections.retainRun("accepted-run", reference)).not.toThrow();
    expect(() =>
      connections.retainRun("accepted-run", { ...reference, executionId: "different" }),
    ).toThrow();
  });
  it("preserves the active instance when a candidate is rolled back", () => {
    const previous = install();
    const next = incoming();
    next.agents[0]!.runtime!.connection_id = "rci_22222222222222222222222222222222";
    next.agents[0]!.runtime!.runtime_revision = "rtv_22222222222222222222222222222222";
    next.agents[0]!.runtime!.credential!.token = Buffer.alloc(32, 9).toString("base64url");
    connections.prepare(next).rollback();
    expect(() => connections.fetchFor(previous)).not.toThrow();
    expect(readdirSync(connections.directory)).toEqual([previous.connectionId]);
  });
  it("re-reads the trusted file on every request without a cached fallback", async () => {
    const reference = install();
    const send = connections.fetchFor(reference);
    await send(reference.mcpEndpoint);
    unlinkSync(file());
    await expect(send(reference.mcpEndpoint)).rejects.toThrow(
      expect.objectContaining({ code: "runtime_connection_unavailable" }),
    );
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["changed token", () => writeFileSync(file(), Buffer.alloc(32, 8).toString("base64url"))],
    ["empty", () => writeFileSync(file(), "")],
    [
      "non-ASCII bytes",
      () =>
        writeFileSync(
          file(),
          readFileSync(file()).map((byte) => byte | 0x80),
        ),
    ],
    ["oversized", () => writeFileSync(file(), "a".repeat(8192))],
    ["file mode", () => chmodSync(file(), 0o644)],
    [
      "special file mode",
      () => {
        chmodSync(file(), 0o4600);
        expect(lstatSync(file()).mode & 0o7777).toBe(0o4600);
      },
    ],
    [
      "special directory mode",
      () => {
        const directory = join(connections.directory, binding().connectionId);
        chmodSync(directory, 0o2700);
        expect(lstatSync(directory).mode & 0o7777).toBe(0o2700);
      },
    ],
    ["root directory mode", () => chmodSync(connections.directory, 0o755)],
    ["directory mode", () => chmodSync(join(connections.directory, binding().connectionId), 0o755)],
    [
      "symlink",
      () => {
        const copy = join(connections.directory, "outside");
        writeFileSync(copy, readFileSync(file()), { mode: 0o600 });
        unlinkSync(file());
        symlinkSync(copy, file());
      },
    ],
    ["hard link", () => linkSync(file(), join(connections.directory, "other-link"))],
  ] as const)(
    "rejects %s before HTTP without exposing a token or file path",
    async (_name, mutate) => {
      const reference = install();
      mutate();
      const failure = await connections
        .fetchFor(reference)(reference.mcpEndpoint)
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "runtime_connection_unavailable" });
      expect(String(failure)).not.toContain(connections.directory);
      expect(String(failure)).not.toContain(incoming().agents[0]!.runtime!.credential!.token);
      expect(transport.send).not.toHaveBeenCalled();
    },
  );
  it("strips unrelated authority while preserving MCP, trace and execution-fence headers", async () => {
    const reference = install();
    const headers = {
      Authorization: "Bearer user-key",
      Cookie: "session=user-key",
      "Antnest-Service-Authorization": "Bearer unrelated-service-key",
      "Antnest-Caller-Context": "forged-context",
      "X-Antnest-Organization-ID": "other-org",
      "Proxy-Authorization": "Bearer proxy-key",
      "X-Antnest-Expected-Execution-ID": "forged-execution",
      "MCP-Session-ID": "session-1",
      "MCP-Protocol-Version": "2026-07-28",
      "MCP-Method": "tools/call",
      "MCP-Name": "read",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
    };
    await connections.fetchFor(reference)(reference.mcpEndpoint, {
      method: "POST",
      headers,
      body: "{}",
    });
    const [url, options] = transport.send.mock.calls[0]!;
    const actual = new Headers(options.headers);
    expect(url).toBe(reference.mcpEndpoint);
    expect(actual.get("Antnest-Service-Authorization")).toBe(
      "Bearer " + incoming().agents[0]!.runtime!.credential!.token,
    );
    expect(actual.get("X-Antnest-Expected-Execution-ID")).toBe(reference.executionId);
    expect(actual.get("MCP-Session-ID")).toBe("session-1");
    expect(actual.get("MCP-Protocol-Version")).toBe("2026-07-28");
    expect(actual.get("MCP-Method")).toBe("tools/call");
    expect(actual.get("MCP-Name")).toBe("read");
    for (const name of [
      "Authorization",
      "Cookie",
      "Proxy-Authorization",
      "Antnest-Caller-Context",
      "X-Antnest-Organization-ID",
    ])
      expect(actual.has(name)).toBe(false);
    expect(options).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(options.dispatcher).toBeDefined();
    expect(headers.Authorization).toBe("Bearer user-key");
  });
  it.each(["install", "digest"])(
    "preserves a separate signed maintenance ticket on the private Skill %s route",
    async (action) => {
      const reference = install();
      await connections.fetchFor(reference)(
        new URL(`/internal/skill-maintenance/${action}`, reference.mcpEndpoint),
        {
          method: "POST",
          headers: { Authorization: "AntnestMaintenance a.b.c" },
        },
      );
      expect(new Headers(transport.send.mock.calls[0]![1].headers).get("Authorization")).toBe(
        "AntnestMaintenance a.b.c",
      );
    },
  );
  it.each(["prepare", "check", "commit", "observe", "cancel", "release", "revert"])(
    "rejects the unlisted private Skill maintenance action %s before sending",
    async (action) => {
      const reference = install();
      await expect(
        connections.fetchFor(reference)(
          new URL(`/internal/skill-maintenance/${action}`, reference.mcpEndpoint),
          { method: "POST", headers: { Authorization: "AntnestMaintenance a.b.c" } },
        ),
      ).rejects.toMatchObject({ code: "runtime_connection_unavailable" });
      expect(transport.send).not.toHaveBeenCalled();
    },
  );
  it.each([
    "http://other-runtime:8080/mcp",
    "https://runtime-1:8080/mcp",
    "http://user:pass@runtime-1:8080/mcp",
    "http://runtime-1:8080/mcp?target=x",
    "http://runtime-1:8080/mcp#x",
    "http://runtime-1:8080/user-tool-url",
  ])("rejects an untrusted target: %s", async (url) => {
    const reference = install();
    await expect(connections.fetchFor(reference)(url)).rejects.toThrow(
      expect.objectContaining({ code: "runtime_connection_unavailable" }),
    );
    expect(transport.send).not.toHaveBeenCalled();
  });
  it("does not select a credential by endpoint alone or accept a forged binding", () => {
    const reference = install();
    expect(() => connections.fetchFor({ ...reference, executionId: "forged" })).toThrow();
    expect(() =>
      connections.fetchFor({ ...reference, connectionId: "rci_22222222222222222222222222222222" }),
    ).toThrow();
  });
  it.each([
    { authMode: "token", allowInsecureTransport: undefined },
    { authMode: "token", allowInsecureTransport: " true" },
    { authMode: "token", allowInsecureTransport: "false" },
    { authMode: "mtls", allowInsecureTransport: "true" },
    { authMode: "mtls", allowInsecureTransport: "false" },
  ])("fails unsupported Runtime transport configuration at startup: %j", (options) => {
    expect(() => new RuntimeConnections(options)).toThrow(
      "Runtime transport configuration is unsupported",
    );
  });
  it("destroys its dispatcher and removes the process-private directory on shutdown", async () => {
    install();
    const directory = connections.directory;
    await connections.close();
    expect(existsSync(directory)).toBe(false);
    expect(transport.destroy).toHaveBeenCalledTimes(1);
    expect(() => connections.prepare(incoming())).toThrow();
  });
});
