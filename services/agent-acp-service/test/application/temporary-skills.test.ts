import { describe, expect, it, vi } from "vitest";
import { TemporarySkills } from "../../src/application/temporary-skills.js";
import type {
  TemporarySkillStore,
  TemporarySkillRuntime,
  TemporarySkillScope,
} from "../../src/ports/temporary-skills.js";
import { snapshot } from "../support/fixtures.js";
import { packageWithFiles, packageWithFilesDigest } from "../fixtures/skill-discovery-package.js";

const scope: TemporarySkillScope = {
  runId: "run_1",
  organizationId: "org_1",
  agentId: "agent_1",
  executionId: "execution-1",
  mcpEndpoint: "http://runtime:8093/mcp",
};
const pkg = {
  artifact: packageWithFiles,
  artifactDigest: `sha256:${"a".repeat(64)}`,
  contentDigest: packageWithFilesDigest,
  skillText: "guidance",
  requiresRuntimeDelivery: true,
};
function fixture() {
  const order: string[] = [];
  const store = {
    reserve: vi.fn<TemporarySkillStore["reserve"]>(() => {
      order.push("reserve");
      return Promise.resolve(scope);
    }),
    forRun: vi.fn<TemporarySkillStore["forRun"]>(() => Promise.resolve(scope)),
    forAgent: vi.fn<TemporarySkillStore["forAgent"]>(() => Promise.resolve([scope])),
    next: vi.fn<TemporarySkillStore["next"]>(() => Promise.resolve(scope)),
    released: vi.fn<TemporarySkillStore["released"]>(() => {
      order.push("released");
      return Promise.resolve();
    }),
  };
  const runtime = {
    install: vi.fn<TemporarySkillRuntime["install"]>(() => {
      order.push("install");
      return Promise.resolve({
        path: "/workspace/.antnest/skill-temporary/v1/a/b/package",
        unpacked_size: 80,
      });
    }),
    cleanup: vi.fn<TemporarySkillRuntime["cleanup"]>(() => {
      order.push("cleanup");
      return Promise.resolve();
    }),
  };
  const service = new TemporarySkills(store, runtime);
  const input = { runId: scope.runId, snapshot: snapshot(), signal: new AbortController().signal };
  return { order, store, runtime, service, input };
}
describe("durable temporary Skill scope", () => {
  it("records intent before any Runtime write and leaves it pending until cleanup", async () => {
    const f = fixture();
    await f.service.install(f.input, pkg);
    expect(f.order).toEqual(["reserve", "install"]);
    expect(f.store.released).not.toHaveBeenCalled();
  });
  it("never dispatches if the durable scope write fails", async () => {
    const f = fixture();
    f.store.reserve.mockRejectedValue(new Error("database failed"));
    await expect(f.service.install(f.input, pkg)).rejects.toThrow();
    expect(f.runtime.install).not.toHaveBeenCalled();
  });
  it("retains pending cleanup on an uncertain install and does not reinstall", async () => {
    const f = fixture();
    f.runtime.install.mockImplementation(() => {
      f.order.push("install");
      return Promise.reject(
        Object.assign(new Error("lost response"), {
          effectState: "unknown",
          runtimeCallStopped: false,
        }),
      );
    });
    await expect(f.service.install(f.input, pkg)).rejects.toMatchObject({ effectState: "unknown" });
    await f.service.releaseRun(scope.runId, new AbortController().signal);
    expect(f.runtime.install).toHaveBeenCalledTimes(1);
    expect(f.order).toEqual(["reserve", "install", "cleanup", "released"]);
  });
  it("does not confirm release when cleanup or its durable write fails", async () => {
    const f = fixture();
    f.runtime.cleanup.mockRejectedValue(new Error("unavailable"));
    await expect(f.service.releaseRun(scope.runId, new AbortController().signal)).rejects.toThrow();
    expect(f.store.released).not.toHaveBeenCalled();
  });
  it("reconciles only the selected Agent's pending scopes before admission", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await f.service.releaseAgent({ organizationId: "org_1", agentId: "agent_1" }, signal);
    expect(f.store.forAgent).toHaveBeenCalledWith(
      { organizationId: "org_1", agentId: "agent_1" },
      signal,
    );
    expect(f.order).toEqual(["cleanup", "released"]);
  });
  it("blocks maintenance before model work while a scope is pending", async () => {
    const f = fixture();
    await expect(
      f.service.assertClearAgent(
        { organizationId: "org_1", agentId: "agent_1" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "runtime_barrier_required" });
  });
  it("does not create a scope after cancellation or do cleanup without a pending scope", async () => {
    const f = fixture();
    await expect(
      f.service.install({ ...f.input, signal: AbortSignal.abort() }, pkg),
    ).rejects.toThrow();
    expect(f.store.reserve).not.toHaveBeenCalled();
    f.store.forRun.mockResolvedValue(null);
    await f.service.releaseRun(scope.runId, new AbortController().signal);
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });
});
