import { describe, expect, it, vi } from "vitest";
import { TemporarySkillCleanupWorker } from "../../src/application/temporary-skill-cleanup-worker.js";
import { LearningForegroundGate } from "../../src/application/learning-foreground-gate.js";
import type { TemporarySkills } from "../../src/application/temporary-skills.js";
const scope = {
  organizationId: "organization-1",
  agentId: "agent-1",
  runId: "run-1",
  executionId: "execution-1",
  mcpEndpoint: "http://runtime:8093/mcp",
};
function setup() {
  const gate = new LearningForegroundGate(() => false),
    skills = {
      next: vi.fn<TemporarySkills["next"]>().mockResolvedValue(scope),
      release: vi.fn<TemporarySkills["release"]>().mockResolvedValue(),
    },
    report = vi.fn();
  return {
    gate,
    skills,
    report,
    worker: new TemporarySkillCleanupWorker({ gate, skills, report, delayMs: 1 }),
  };
}
describe("temporary Skill cleanup worker", () => {
  it("releases only durable ended scopes and rotates past a pending scope", async () => {
    const f = setup();
    f.skills.release.mockRejectedValueOnce(new Error("private-body"));
    expect(await f.worker.once(new AbortController().signal)).toBe("pending");
    expect(await f.worker.once(new AbortController().signal)).toBe("released");
    expect(f.skills.next.mock.calls.map((call) => call[0])).toEqual([null, scope.runId]);
    expect(f.report.mock.calls).toEqual([["pending"], ["released"]]);
  });
  it("does not overlap an active foreground or maintenance slot", async () => {
    const f = setup(),
      lease = f.gate.begin(scope, new AbortController().signal);
    expect(await f.worker.once(new AbortController().signal)).toBe("pending");
    expect(f.skills.release).not.toHaveBeenCalled();
    lease.finish(true);
  });
  it("foreground preemption waits for local cleanup to stop and leaves the scope pending", async () => {
    const f = setup(),
      started = Promise.withResolvers<void>();
    f.skills.release.mockImplementation((_scope, signal) => {
      started.resolve();
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("Cleanup preempted")), {
          once: true,
        }),
      );
    });
    const cleanup = f.worker.once(new AbortController().signal);
    await started.promise;
    await f.gate.preempt(scope, new AbortController().signal);
    expect(await cleanup).toBe("pending");
  });
  it("does not interpret temporary cleanup as recovery of an unrelated unknown learning effect", async () => {
    const f = setup();
    f.gate.begin(scope, new AbortController().signal).finish(false);
    expect(await f.worker.once(new AbortController().signal)).toBe("released");
    await expect(f.gate.preempt(scope, new AbortController().signal)).rejects.toMatchObject({
      code: "runtime_barrier_required",
    });
  });
  it("resetting the cursor does not wait in a lease and shutdown observes cancellation", async () => {
    const f = setup();
    f.skills.next.mockResolvedValue(null);
    const controller = new AbortController();
    const running = f.worker.run(controller.signal);
    await vi.waitFor(() => expect(f.skills.next).toHaveBeenCalled());
    controller.abort();
    await running;
    expect(f.skills.release).not.toHaveBeenCalled();
    expect(f.skills.next.mock.calls.every((call) => call[0] === null)).toBe(true);
  });
});
