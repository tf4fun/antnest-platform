import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RuntimeSkillTemporaryClient } from "../../src/adapters/runtime-skill-temporary-client.js";
import { RuntimeSkillMaintenanceSigner } from "../../src/adapters/runtime-skill-maintenance-signer.js";
import { packageWithFiles, packageWithFilesDigest } from "../fixtures/skill-discovery-package.js";
import type { RuntimeBinding } from "../../src/domain/types.js";

const scope = {
  revision: `rtv_${"a".repeat(32)}`,
  connectionId: `rci_${"b".repeat(32)}`,
  runId: "run_1",
  organizationId: "org_1",
  agentId: "agent_1",
  executionId: "execution-1",
  mcpEndpoint: "http://runtime:8093/mcp",
};
const loaded = {
  artifact: packageWithFiles,
  contentDigest: packageWithFilesDigest,
  artifactDigest: `sha256:${createHash("sha256").update(packageWithFiles).digest("hex")}`,
  skillText: "guidance",
  requiresRuntimeDelivery: true,
};
const path = `/workspace/.antnest/skill-temporary/v1/${"a".repeat(64)}/${packageWithFilesDigest.slice(7)}/package`;
function fixture() {
  const pair = generateKeyPairSync("ed25519");
  const signer = new RuntimeSkillMaintenanceSigner("key-1", pair.privateKey);
  const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
  const connections = {
    fetchFor: vi.fn<(binding: RuntimeBinding) => typeof fetch>(
      () =>
        (url, init = {}) =>
          fetchFn(
            url instanceof Request ? url.url : typeof url === "string" ? url : url.href,
            init,
          ),
    ),
    retainRun: vi.fn<(runId: string, binding: RuntimeBinding) => void>(),
  };
  const client = new RuntimeSkillTemporaryClient(signer, connections, {
    installTimeoutMs: 100,
    cleanupTimeoutMs: 100,
  });
  return { client, fetchFn, pair, connections };
}
function installReply(init: RequestInit, patch: Record<string, unknown> = {}) {
  const token = new Headers(init.headers).get("Authorization")!.split(" ")[1]!.split(".");
  const payload = JSON.parse(Buffer.from(token[1]!, "base64url").toString()) as Record<
    string,
    unknown
  >;
  return Response.json(
    {
      action: "temporary_install",
      request_id: payload.request_id,
      job_id: scope.runId,
      execution_id: scope.executionId,
      outcome: "installed",
      temporary_path: path,
      content_digest: loaded.contentDigest,
      artifact_digest: loaded.artifactDigest,
      unpacked_size: 80,
      effect_state: "settled",
      runtime_call_stopped: true,
      ...patch,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
function status(execution = scope.executionId, agent = scope.agentId) {
  return Response.json({ status: "ready", agent_id: agent, execution_id: execution });
}
describe("signed Runtime temporary client", () => {
  it("rejects missing sender material before install I/O and leaves cleanup unconfirmed", async () => {
    const f = fixture();
    f.connections.retainRun.mockImplementation(() => {
      throw new Error("Runtime connection is unavailable");
    });
    await expect(
      f.client.install(scope, loaded, new AbortController().signal),
    ).rejects.toMatchObject({ effectState: "none", runtimeCallStopped: true });
    expect(f.fetchFn).not.toHaveBeenCalled();
    f.connections.fetchFor.mockImplementation(() => {
      throw new Error("Runtime connection is unavailable");
    });
    await expect(f.client.cleanup(scope, new AbortController().signal)).rejects.toMatchObject({
      effectState: "unknown",
      runtimeCallStopped: false,
    });
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it.each([
    [401, "runtime_unauthorized"],
    [403, "caller_not_allowed"],
    [403, "host_not_allowed"],
  ] as const)(
    "recognizes native admission denial %i/%s before temporary installation",
    async (statusCode, code) => {
      const f = fixture();
      f.fetchFn.mockResolvedValue(
        Response.json(
          { code, message: "Runtime request rejected", retryable: false },
          {
            status: statusCode,
            headers:
              statusCode === 401 ? { "WWW-Authenticate": 'Bearer realm="antnest-service"' } : {},
          },
        ),
      );
      await expect(
        f.client.install(scope, loaded, new AbortController().signal),
      ).rejects.toMatchObject({ effectState: "none", runtimeCallStopped: true, remoteCode: code });
      expect(f.connections.fetchFor).toHaveBeenCalledWith(
        expect.objectContaining({
          revision: scope.revision,
          connectionId: scope.connectionId,
          executionId: scope.executionId,
          mcpEndpoint: scope.mcpEndpoint,
        }),
      );
    },
  );
  it("does not use a denied release as proof that an earlier install has been cleaned", async () => {
    const f = fixture();
    f.fetchFn.mockImplementation((url) =>
      Promise.resolve(
        url.endsWith("/status")
          ? status()
          : Response.json(
              { code: "caller_not_allowed", message: "Runtime request rejected", retryable: false },
              { status: 403 },
            ),
      ),
    );
    await expect(f.client.cleanup(scope, new AbortController().signal)).rejects.toMatchObject({
      effectState: "unknown",
      runtimeCallStopped: false,
    });
    expect(f.fetchFn).toHaveBeenCalledTimes(2);
  });
  it("checks a newly published endpoint after rebuild rather than treating a missing old endpoint as cleanup proof", async () => {
    const f = fixture();
    const current = {
      revision: `rtv_${"c".repeat(32)}`,
      connectionId: `rci_${"d".repeat(32)}`,
      executionId: "execution-2",
      mcpEndpoint: "http://replacement:8093/mcp",
    };
    const client = new RuntimeSkillTemporaryClient(
      undefined,
      f.connections,
      undefined,
      () => current,
    );
    f.fetchFn.mockResolvedValue(status("execution-2"));
    await client.cleanup(scope, new AbortController().signal);
    expect(f.connections.fetchFor).toHaveBeenCalledWith(current);
    expect(
      new Headers(f.fetchFn.mock.calls[0]![1].headers).get("X-Antnest-Expected-Execution-ID"),
    ).toBe(current.executionId);
    expect(f.fetchFn.mock.calls[0]![0]).toBe("http://replacement:8093/status");
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each(["revision", "connectionId", "mcpEndpoint"] as const)(
    "rejects a changed %s under the same execution identity",
    async (field) => {
      const f = fixture();
      const current = {
        revision: scope.revision,
        connectionId: scope.connectionId,
        executionId: scope.executionId,
        mcpEndpoint: scope.mcpEndpoint,
        [field]:
          field === "mcpEndpoint"
            ? "http://replacement:8093/mcp"
            : `${field === "revision" ? "rtv" : "rci"}_${"f".repeat(32)}`,
      };
      const client = new RuntimeSkillTemporaryClient(
        undefined,
        f.connections,
        undefined,
        () => current,
      );
      f.fetchFn.mockResolvedValue(status());
      await expect(client.cleanup(scope, new AbortController().signal)).rejects.toMatchObject({
        effectState: "unknown",
        runtimeCallStopped: false,
      });
      expect(f.fetchFn).not.toHaveBeenCalled();
    },
  );
  it("does not accept a replacement endpoint reporting a different execution than its published binding", async () => {
    const f = fixture();
    const client = new RuntimeSkillTemporaryClient(undefined, f.connections, undefined, () => ({
      revision: `rtv_${"c".repeat(32)}`,
      connectionId: `rci_${"d".repeat(32)}`,
      executionId: "execution-2",
      mcpEndpoint: "http://replacement:8093/mcp",
    }));
    f.fetchFn.mockResolvedValue(status("execution-3"));
    await expect(client.cleanup(scope, new AbortController().signal)).rejects.toMatchObject({
      effectState: "unknown",
      runtimeCallStopped: false,
    });
  });
  it("keeps an old scope pending when its signing key is absent and does not send unsigned mutations", async () => {
    const f = fixture();
    const client = new RuntimeSkillTemporaryClient(undefined, f.connections);
    f.fetchFn.mockResolvedValue(status());
    await expect(client.cleanup(scope, new AbortController().signal)).rejects.toThrow();
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
    await expect(client.install(scope, loaded, new AbortController().signal)).rejects.toMatchObject(
      { effectState: "none", runtimeCallStopped: true },
    );
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });
  it("signs exact multipart bytes with separate Run authority and accepts only confirmed files", async () => {
    const f = fixture();
    f.fetchFn.mockImplementation((_url, init) => Promise.resolve(installReply(init)));
    expect(await f.client.install(scope, loaded, new AbortController().signal)).toEqual({
      path,
      unpacked_size: 80,
    });
    const [url, init] = f.fetchFn.mock.calls[0]!;
    expect(url).toBe("http://runtime:8093/internal/skill-temporary/install");
    const [header, payload, signature] = new Headers(init.headers)
      .get("Authorization")!
      .split(" ")[1]!
      .split(".") as [string, string, string];
    expect(
      verify(
        null,
        Buffer.from(`antnest-skill-maintenance-v1\n${header}.${payload}`),
        f.pair.publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
      action: "temporary_install",
      job_id: scope.runId,
      generation: 1,
      body_sha256: `sha256:${createHash("sha256")
        .update(init.body as Buffer)
        .digest("hex")}`,
    });
    expect(init.redirect).toBe("error");
  });
  it.each([
    { execution_id: "old" },
    { job_id: "other" },
    { temporary_path: "/skills/unsafe" },
    { content_digest: `sha256:${"b".repeat(64)}` },
    { artifact_digest: `sha256:${"b".repeat(64)}` },
    { effect_state: "none" },
    { runtime_call_stopped: false },
    { extra: "body" },
  ])("rejects uncertain/mismatched install receipts: %j", async (patch) => {
    const f = fixture();
    f.fetchFn.mockImplementation((_url, init) => Promise.resolve(installReply(init, patch)));
    await expect(
      f.client.install(scope, loaded, new AbortController().signal),
    ).rejects.toMatchObject({ effectState: "unknown", runtimeCallStopped: false });
  });
  it("preserves a proved pre-dispatch refusal and sanitizes transport failures", async () => {
    const f = fixture();
    f.fetchFn.mockResolvedValue(
      Response.json(
        {
          error: {
            code: "runtime_busy",
            message: "Temporary Skill request did not complete",
            retryable: true,
            effect_state: "none",
            runtime_call_stopped: true,
          },
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      ),
    );
    await expect(
      f.client.install(scope, loaded, new AbortController().signal),
    ).rejects.toMatchObject({ effectState: "none", runtimeCallStopped: true });
    f.fetchFn.mockRejectedValue(new Error("credential-and-private-body"));
    await expect(
      f.client.install(scope, loaded, new AbortController().signal),
    ).rejects.toMatchObject({
      effectState: "unknown",
      message: "Temporary Skill delivery is unavailable.",
    });
  });
  it("cancellation after dispatch and an adapter ignoring cancellation are bounded unknown effects", async () => {
    const f = fixture();
    f.fetchFn.mockImplementation(() => new Promise(() => {}));
    await expect(
      f.client.install(scope, loaded, new AbortController().signal),
    ).rejects.toMatchObject({ effectState: "unknown", runtimeCallStopped: false });
  });
  it("does no I/O for an already cancelled install", async () => {
    const f = fixture();
    await expect(f.client.install(scope, loaded, AbortSignal.abort())).rejects.toMatchObject({
      effectState: "none",
      runtimeCallStopped: true,
    });
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it("does not trust a new execution returned through only the original binding", async () => {
    const f = fixture();
    f.fetchFn.mockResolvedValue(status("execution-2"));
    await expect(f.client.cleanup(scope, new AbortController().signal)).rejects.toMatchObject({
      effectState: "unknown",
      runtimeCallStopped: false,
    });
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });
  it.each([
    status("execution-2", "other-agent"),
    Response.json({ status: "starting", agent_id: scope.agentId, execution_id: "execution-2" }),
  ])("does not assume cleanup from another Agent or unready status", async (response) => {
    const f = fixture();
    f.fetchFn.mockResolvedValue(response);
    await expect(f.client.cleanup(scope, new AbortController().signal)).rejects.toThrow();
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });
  it("original execution requires its exact settled release before cleanup success", async () => {
    const f = fixture();
    f.fetchFn.mockImplementation((url, init) => {
      if (url.endsWith("/status")) return Promise.resolve(status());
      const request = JSON.parse((init.body as Buffer).toString()) as Record<string, unknown>;
      return Promise.resolve(
        Response.json(
          {
            ...request,
            execution_id: scope.executionId,
            outcome: "released",
            effect_state: "settled",
            runtime_call_stopped: true,
            generation: undefined,
          },
          { headers: { "cache-control": "no-store" } },
        ),
      );
    });
    await f.client.cleanup(scope, new AbortController().signal);
    expect(f.fetchFn).toHaveBeenCalledTimes(2);
  });
});
