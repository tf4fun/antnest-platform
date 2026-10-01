import { describe, expect, it, vi } from "vitest";
import { SkillDiscoveryTools } from "../../src/application/skill-discovery-tools.js";
import { skillDiscoveryTools } from "../../src/domain/skill-discovery.js";
import type {
  SkillDiscoveryPort,
  SkillDiscoveryAuthority,
} from "../../src/ports/skill-discovery.js";
import type { ToolCallInput, ToolCatalogPort } from "../../src/ports/tools.js";
import { snapshot } from "../support/fixtures.js";
import type { TelemetryPort, TelemetryAttributes } from "../../src/ports/telemetry.js";

const organizationId = `org_${"1".repeat(32)}`;
const principalId = `user_${"2".repeat(32)}`;
const agentId = `agent_${"3".repeat(32)}`;
const ref = {
  kind: "agent" as const,
  agent_id: `agent_${"4".repeat(32)}`,
  name: "test-skill",
  sequence: 1,
};
const digest = `sha256:${"a".repeat(64)}`;
const item = {
  skill_ref: ref,
  name: "test-skill",
  description: "A procedure",
  content_digest: digest,
};

function fixture(telemetry?: TelemetryPort) {
  const temporary = {
    install: vi.fn(() =>
      Promise.resolve({
        path: `/workspace/.antnest/skill-temporary/v1/${"b".repeat(64)}/${"a".repeat(64)}/package`,
        unpacked_size: 80,
      }),
    ),
  };
  const runtime = {
    list: vi.fn<ToolCatalogPort["list"]>(() => Promise.resolve([])),
    call: vi.fn<ToolCatalogPort["call"]>(),
  } satisfies ToolCatalogPort;
  const authority = {
    authorize: vi.fn<SkillDiscoveryAuthority["authorize"]>(() =>
      Promise.resolve({ organizationId, principalId, agentId }),
    ),
  } satisfies SkillDiscoveryAuthority;
  const registry = {
    search: vi.fn<SkillDiscoveryPort["search"]>(() => Promise.resolve({ items: [item] })),
    load: vi.fn<SkillDiscoveryPort["load"]>(() =>
      Promise.resolve({
        skillText: "---\nname: test-skill\ndescription: A procedure\n---\nSteps",
        artifactDigest: digest,
        contentDigest: digest,
        requiresRuntimeDelivery: false,
      }),
    ),
  } satisfies SkillDiscoveryPort;
  const tools = new SkillDiscoveryTools({
    runtime,
    authority,
    registry,
    temporary,
    ...(telemetry ? { telemetry } : {}),
  });
  const input = (
    name: "find_skill" | "load_skill",
    args?: Record<string, unknown>,
  ): ToolCallInput => ({
    runId: "run-1",
    snapshot: { ...snapshot(), organizationId },
    tool: skillDiscoveryTools.find((tool) => tool.name === name)!,
    arguments:
      args ??
      (name === "find_skill"
        ? { query: " procedure " }
        : { skill_ref: ref, expected_digest: digest }),
    signal: new AbortController().signal,
  });
  return { tools, runtime, registry, authority, temporary, input };
}

describe("ACP platform Skill discovery", () => {
  it("adds explicit platform tools with temporary-write semantics without contacting Registry", async () => {
    const f = fixture();
    const catalog = await f.tools.list(snapshot(), new AbortController().signal);
    expect(catalog).toEqual(skillDiscoveryTools);
    expect(
      catalog.map((tool) => [tool.source, tool.sourceId, tool.annotations?.readOnlyHint]),
    ).toEqual([
      ["agent", "skill_registry", true],
      ["agent", "skill_registry", false],
    ]);
    expect(f.registry.search).not.toHaveBeenCalled();
  });

  it.each(["find_skill", "load_skill"])("rejects a Runtime collision with %s", async (name) => {
    const f = fixture();
    vi.mocked(f.runtime.list).mockResolvedValue([
      { source: "runtime", sourceId: "runtime", name, modelName: name, description: "collision" },
    ]);
    await expect(f.tools.list(snapshot(), new AbortController().signal)).rejects.toMatchObject({
      code: "tool_name_collision",
    });
  });

  it("derives the caller Agent, actor and tenant from the persisted Run and rechecks before delivery", async () => {
    const f = fixture();
    const input = f.input("find_skill");
    const result = await f.tools.call(input);
    expect(f.registry.search).toHaveBeenCalledWith(
      {
        organization_id: organizationId,
        actor_id: principalId,
        requesting_agent_id: agentId,
        query: "procedure",
      },
      input.signal,
    );
    expect(f.authority.authorize).toHaveBeenCalledTimes(2);
    expect(f.runtime.call).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      isError: false,
      toolEffectState: "none",
      structuredContent: { items: [item] },
    });
  });

  it.each([
    { query: "x", organization_id: organizationId },
    { query: "x", requesting_agent_id: ref.agent_id },
    { query: "x", requesting_agent_id: agentId },
    { query: "你".repeat(86) },
    { query: " " },
    { query: "x", limit: 0 },
  ])("rejects unauthorized/invalid arguments before I/O: %j", async (args) => {
    const f = fixture();
    expect(await f.tools.call(f.input("find_skill", args))).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "invalid_request" } },
    });
    expect(f.registry.search).not.toHaveBeenCalled();
    expect(f.authority.authorize).not.toHaveBeenCalled();
  });

  it("discards search candidates if the persisted caller changes during I/O", async () => {
    const f = fixture();
    f.authority.authorize
      .mockResolvedValueOnce({ organizationId, principalId, agentId })
      .mockResolvedValueOnce({ organizationId, principalId, agentId: ref.agent_id });
    const result = await f.tools.call(f.input("find_skill"));
    expect(result).toMatchObject({
      isError: true,
      toolEffectState: "none",
      structuredContent: { error: { code: "not_found" } },
    });
    expect(JSON.stringify(result)).not.toContain(item.name);
  });

  it("loads exact selected text without claiming Runtime files", async () => {
    const f = fixture();
    const input = f.input("load_skill");
    const result = await f.tools.call(input);
    expect(f.registry.load).toHaveBeenCalledWith(
      {
        organization_id: organizationId,
        actor_id: principalId,
        skill_ref: ref,
        expected_digest: digest,
      },
      input.signal,
    );
    expect(result).toMatchObject({
      isError: false,
      toolEffectState: "none",
      structuredContent: {
        skill_ref: ref,
        content_digest: digest,
        artifact_digest: digest,
        temporary_files: null,
        requires_runtime_delivery: false,
      },
    });
    expect(JSON.stringify(result)).toContain("Steps");
  });
  it("delivers multi-file packages only after access recheck and returns confirmed paths", async () => {
    const f = fixture();
    f.registry.load.mockResolvedValue({
      artifact: Buffer.from("package"),
      skillText: "Steps",
      contentDigest: digest,
      artifactDigest: digest,
      requiresRuntimeDelivery: true,
    });
    const result = await f.tools.call(f.input("load_skill"));
    expect(f.temporary.install).toHaveBeenCalledTimes(1);
    expect(f.authority.authorize).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      isError: false,
      toolEffectState: "settled",
      runtimeCallStopped: true,
      structuredContent: {
        temporary_files: { unpacked_size: 80 },
        requires_runtime_delivery: true,
      },
    });
  });
  it("does not hide mutable uncertainty as a discovery read", async () => {
    const f = fixture();
    f.registry.load.mockResolvedValue({
      artifact: Buffer.from("package"),
      skillText: "Steps",
      contentDigest: digest,
      artifactDigest: digest,
      requiresRuntimeDelivery: true,
    });
    const { TemporarySkillFailure } = await import("../../src/domain/temporary-skills.js");
    f.temporary.install.mockRejectedValue(new TemporarySkillFailure("unknown", false));
    expect(await f.tools.call(f.input("load_skill"))).toMatchObject({
      isError: true,
      toolEffectState: "unknown",
      runtimeCallStopped: false,
      structuredContent: { error: { code: "temporary_unavailable" } },
    });
  });
  it("revocation after installation discards source output while preserving settled effect", async () => {
    const f = fixture();
    f.registry.load.mockResolvedValue({
      artifact: Buffer.from("package"),
      skillText: "Steps",
      contentDigest: digest,
      artifactDigest: digest,
      requiresRuntimeDelivery: true,
    });
    f.authority.authorize
      .mockResolvedValueOnce({ organizationId, principalId, agentId })
      .mockResolvedValueOnce({ organizationId, principalId, agentId })
      .mockRejectedValueOnce(Object.assign(new Error("revoked"), { code: "access_denied" }));
    const result = await f.tools.call(f.input("load_skill"));
    expect(result).toMatchObject({
      isError: true,
      toolEffectState: "settled",
      runtimeCallStopped: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/Steps|\/workspace/);
  });

  it("discards loaded bytes when the current authority is revoked", async () => {
    const f = fixture();
    vi.mocked(f.authority.authorize)
      .mockResolvedValueOnce({ organizationId, principalId, agentId })
      .mockRejectedValueOnce(
        Object.assign(new Error("private details"), { code: "access_denied" }),
      );
    const result = await f.tools.call(f.input("load_skill"));
    expect(result).toMatchObject({
      isError: true,
      toolEffectState: "none",
      structuredContent: { error: { code: "not_found" } },
    });
    expect(JSON.stringify(result)).not.toMatch(/Steps|private details/);
  });

  it("keeps outages distinct from an empty search and sanitizes upstream messages", async () => {
    const f = fixture();
    vi.mocked(f.registry.search).mockRejectedValue(
      new Error("http://private-source token-and-body"),
    );
    const result = await f.tools.call(f.input("find_skill"));
    expect(result).toMatchObject({
      isError: true,
      toolEffectState: "none",
      structuredContent: { error: { code: "source_unavailable" } },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-source|token-and-body/);
  });

  it("does not dispatch cancelled reads or create an unknown effect", async () => {
    const f = fixture();
    const input = f.input("load_skill");
    input.signal = AbortSignal.abort();
    await expect(f.tools.call(input)).rejects.toMatchObject({ effectState: "none" });
    expect(f.registry.load).not.toHaveBeenCalled();
  });

  it("traces selected identity without capturing query or returned Skill text", async () => {
    const span = <Result>(
      name: string,
      attributes: TelemetryAttributes,
      operation: () => Promise<Result>,
    ): Promise<Result> => {
      spans.push([name, attributes]);
      return operation();
    };
    const spans: Array<[string, TelemetryAttributes]> = [];
    const f = fixture({ span, count: vi.fn(), duration: vi.fn(), log: vi.fn() });
    await f.tools.call(f.input("find_skill", { query: "private-query" }));
    await f.tools.call(f.input("load_skill"));
    expect(spans.map(([name]) => name)).toEqual(["skill.discovery.search", "skill.discovery.load"]);
    expect(spans[1]?.[1]).toMatchObject({
      "skill.source.agent_id": ref.agent_id,
      "skill.content_digest": digest,
    });
    expect(JSON.stringify(spans.map(([name, attributes]) => ({ name, attributes })))).not.toMatch(
      /private-query|Steps|SKILL.md/,
    );
  });

  it("delegates ordinary Runtime calls and rejects a forged platform identity", async () => {
    const f = fixture();
    const input = f.input("find_skill");
    const result = { content: [], isError: false, toolEffectState: "settled" as const };
    vi.mocked(f.runtime.call).mockResolvedValue(result);
    expect(
      await f.tools.call({
        ...input,
        tool: { ...input.tool, source: "runtime", name: "read", modelName: "read" },
      }),
    ).toEqual(result);
    expect(
      await f.tools.call({ ...input, tool: { ...input.tool, sourceId: "fake" } }),
    ).toMatchObject({ isError: true });
  });
});
