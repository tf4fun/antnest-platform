import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RuntimeSkillTemporaryClient } from "../../src/adapters/runtime-skill-temporary-client.js";
import { RuntimeSkillMaintenanceSigner } from "../../src/adapters/runtime-skill-maintenance-signer.js";
import {
  temporaryErrorSchema,
  temporaryInstalledSchema,
  temporaryReleasedSchema,
} from "../../src/domain/temporary-skills.js";
import type { RuntimeBinding } from "../../src/domain/types.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    randomUUID: () => "11111111-1111-1111-1111-111111111111",
  };
});

interface SharedGoldenHelpers {
  loadGolden: (area: string, file: string) => unknown;
  withFutureFields: (value: unknown) => unknown;
}
const { loadGolden, withFutureFields } = (await import(
  new URL("../../../../tests/support/contracts/golden.mjs", import.meta.url).href
)) as SharedGoldenHelpers;

const scope = {
  revision: `rtv_${"a".repeat(32)}`,
  connectionId: `rci_${"b".repeat(32)}`,
  runId: "run-1",
  organizationId: "org-1",
  agentId: "agent-1",
  executionId: "execution-1",
  mcpEndpoint: "http://runtime:8093/mcp",
};
const loaded = {
  artifact: Buffer.from("synthetic-artifact"),
  contentDigest: `sha256:${"a".repeat(64)}`,
  artifactDigest: `sha256:${"b".repeat(64)}`,
  skillText: "guidance",
  requiresRuntimeDelivery: true,
};

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
    installTimeoutMs: 1000,
    cleanupTimeoutMs: 1000,
  });
  return { client, fetchFn, connections };
}

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });

const clone = (value: unknown): Record<string, unknown> =>
  structuredClone(value) as Record<string, unknown>;

const installDocument = () =>
  loadGolden("runtime", "temporary-install.installed.json") as Record<string, unknown>;
const releaseDocument = () =>
  loadGolden("runtime", "temporary-release.released.json") as Record<string, unknown>;
const errorDocument = () =>
  loadGolden("runtime", "temporary-operation.disabled.json") as Record<string, unknown>;

describe("Runtime temporary producer golden consumption", () => {
  it.each([false, true])("install consumes the captured reply (extended=%s)", async (extended) => {
    const f = fixture();
    const document = installDocument();
    const body = extended ? withFutureFields(document) : document;
    f.fetchFn.mockImplementation(() => Promise.resolve(reply(body)));
    const result = await f.client.install(scope, loaded, new AbortController().signal);
    expect(result).toEqual({
      path: document.temporary_path,
      unpacked_size: document.unpacked_size,
    });
  });

  it.each([false, true])("cleanup consumes the captured reply (extended=%s)", async (extended) => {
    const f = fixture();
    const document = releaseDocument();
    const body = extended ? withFutureFields(document) : document;
    f.fetchFn.mockImplementation((url) =>
      Promise.resolve(
        url.endsWith("/status")
          ? reply({ status: "ready", agent_id: scope.agentId, execution_id: scope.executionId })
          : reply(body),
      ),
    );
    await f.client.cleanup(scope, new AbortController().signal);
    expect(f.fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "install surfaces the captured disabled envelope (extended=%s)",
    async (extended) => {
      const f = fixture();
      const body = extended ? withFutureFields(errorDocument()) : errorDocument();
      f.fetchFn.mockImplementation(() => Promise.resolve(reply(body, 403)));
      await expect(
        f.client.install(scope, loaded, new AbortController().signal),
      ).rejects.toMatchObject({
        effectState: "none",
        runtimeCallStopped: true,
        remoteCode: "temporary_disabled",
      });
    },
  );

  it.each([false, true])(
    "cleanup surfaces the captured disabled envelope as a refused, never-clean proof (extended=%s)",
    async (extended) => {
      const f = fixture();
      const body = extended ? withFutureFields(errorDocument()) : errorDocument();
      f.fetchFn.mockImplementation((url) =>
        Promise.resolve(
          url.endsWith("/status")
            ? reply({ status: "ready", agent_id: scope.agentId, execution_id: scope.executionId })
            : reply(body, 403),
        ),
      );
      await expect(f.client.cleanup(scope, new AbortController().signal)).rejects.toMatchObject({
        effectState: "unknown",
        runtimeCallStopped: false,
        remoteCode: "temporary_disabled",
      });
    },
  );

  it("cleanup refusal on an unknown failure stays unknown, never cleanup evidence", async () => {
    const f = fixture();
    const body = clone(errorDocument());
    (body.error as Record<string, unknown>).code = "invented_code";
    f.fetchFn.mockImplementation((url) =>
      Promise.resolve(
        url.endsWith("/status")
          ? reply({ status: "ready", agent_id: scope.agentId, execution_id: scope.executionId })
          : reply(body, 403),
      ),
    );
    await expect(f.client.cleanup(scope, new AbortController().signal)).rejects.toMatchObject({
      effectState: "unknown",
      runtimeCallStopped: false,
    });
  });

  it("strict domain schemas still reject extension members directly", () => {
    expect(temporaryInstalledSchema.safeParse(withFutureFields(installDocument())).success).toBe(
      false,
    );
    expect(temporaryReleasedSchema.safeParse(withFutureFields(releaseDocument())).success).toBe(
      false,
    );
    expect(temporaryErrorSchema.safeParse(withFutureFields(errorDocument())).success).toBe(false);
  });

  it.each([
    { request_id: "forged-request" },
    { job_id: "other-job" },
    { execution_id: "other-execution" },
    { content_digest: `sha256:${"c".repeat(64)}` },
    { artifact_digest: `sha256:${"c".repeat(64)}` },
    { temporary_path: "/skills/unsafe" },
    {
      temporary_path: `/workspace/.antnest/skill-temporary/v1/${"c".repeat(64)}/${"c".repeat(64)}/package`,
    },
    { effect_state: "none" },
    { runtime_call_stopped: false },
    { unpacked_size: 0 },
  ])("rejects corrupted install replies under extensions: %j", async (patch) => {
    const f = fixture();
    const body = { ...installDocument(), ...patch };
    f.fetchFn.mockImplementation(() => Promise.resolve(reply(withFutureFields(body))));
    await expect(
      f.client.install(scope, loaded, new AbortController().signal),
    ).rejects.toMatchObject({ effectState: "unknown", runtimeCallStopped: false });
  });

  it.each([
    { request_id: "forged-request" },
    { job_id: "other-job" },
    { execution_id: "other-execution" },
    { effect_state: "none" },
    { runtime_call_stopped: false },
  ])("rejects corrupted release replies under extensions: %j", async (patch) => {
    const f = fixture();
    const body = { ...releaseDocument(), ...patch };
    f.fetchFn.mockImplementation((url) =>
      Promise.resolve(
        url.endsWith("/status")
          ? reply({ status: "ready", agent_id: scope.agentId, execution_id: scope.executionId })
          : reply(withFutureFields(body)),
      ),
    );
    await expect(f.client.cleanup(scope, new AbortController().signal)).rejects.toMatchObject({
      effectState: "unknown",
      runtimeCallStopped: false,
    });
  });

  it.each([
    { error: { code: "invented_code" } },
    { error: { retryable: "yes" } },
    { error: { effect_state: "unknown" } },
    { details: { effect_state: "unknown" } },
    { root: { category: "internal" }, error: { category: "internal" } },
    { error: { category: "internal" } },
    { root: { retryable: "yes" } },
    { root: { retryable: true }, error: { retryable: false } },
    { error: { request_id: "different-request" } },
    { details: { runtime_call_stopped: false } },
  ])("rejects corrupted error envelopes under extensions: %j", async (patch) => {
    const f = fixture();
    const body = clone(errorDocument());
    for (const [section, fields] of Object.entries(patch)) {
      const target = section === "root" ? body : (body[section] as Record<string, unknown>);
      Object.assign(target, fields);
    }
    f.fetchFn.mockImplementation(() => Promise.resolve(reply(withFutureFields(body), 403)));
    await expect(
      f.client.install(scope, loaded, new AbortController().signal),
    ).rejects.toMatchObject({ effectState: "unknown", runtimeCallStopped: false });
  });

  it.each([
    { headers: { "cache-control": "public" } },
    { headers: { "content-type": "text/plain" } },
    { omit: ["cache-control"] },
    { omit: ["content-type"] },
  ])(
    "rejects missing/incorrect response policy headers under extensions: %j",
    async ({ headers, omit }: { headers?: Record<string, string>; omit?: string[] }) => {
      const f = fixture();
      const response = reply(withFutureFields(installDocument()), 200, headers);
      for (const key of omit ?? []) response.headers.delete(key);
      f.fetchFn.mockImplementation(() => Promise.resolve(response));
      await expect(
        f.client.install(scope, loaded, new AbortController().signal),
      ).rejects.toMatchObject({ effectState: "unknown", runtimeCallStopped: false });
    },
  );

  it("accepts the legacy error shape derived from the captured envelope under extensions", async () => {
    const f = fixture();
    const captured = errorDocument().error as Record<string, unknown>;
    const legacy = {
      error: {
        code: captured.code,
        message: captured.message,
        effect_state: captured.effect_state,
        runtime_call_stopped: captured.runtime_call_stopped,
        retryable: captured.retryable,
      },
    };
    f.fetchFn.mockImplementation(() => Promise.resolve(reply(withFutureFields(legacy), 403)));
    await expect(
      f.client.install(scope, loaded, new AbortController().signal),
    ).rejects.toMatchObject({
      effectState: "none",
      runtimeCallStopped: true,
      remoteCode: "temporary_disabled",
    });
  });
});
