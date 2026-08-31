import { describe, expect, it } from "vitest";

import { classifyRunRecovery, transitionRun } from "../../src/domain/run.js";

describe("Run state", () => {
  it("recovers admission but never replays a running Tool loop", () => {
    expect(classifyRunRecovery("admitting")).toBe("retry_admission");
    expect(classifyRunRecovery("running")).toBe("finish_unresolved");
    expect(classifyRunRecovery("completed")).toBe("none");
    expect(classifyRunRecovery("cancelled")).toBe("none");
    expect(classifyRunRecovery("failed")).toBe("none");
    expect(classifyRunRecovery("unresolved")).toBe("none");
  });

  it("allows only explicit lifecycle transitions", () => {
    expect(transitionRun("admitting", "running")).toBe("running");
    expect(transitionRun("running", "completed")).toBe("completed");
    expect(transitionRun("running", "unresolved")).toBe("unresolved");
    expect(() => transitionRun("completed", "running")).toThrow(/transition/u);
    expect(() => transitionRun("admitting", "completed")).toThrow(/transition/u);
  });
});
