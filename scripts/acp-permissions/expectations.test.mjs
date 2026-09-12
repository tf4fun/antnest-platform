import assert from "node:assert/strict";
import test from "node:test";
import { verifyModelRequests } from "./expectations.mjs";

function requests() {
  return [1, 2].flatMap((version) =>
    [
      "once",
      "once-again",
      "deny",
      "always",
      "follow",
      "reject",
      "reject-follow",
      "chat",
      "read-hint",
      "judge-safe",
      "judge-ask",
      "cancel",
      "reconnect",
    ].flatMap((phase) => {
      const stages = ["cancel", "chat"].includes(phase)
        ? [0]
        : phase.startsWith("judge-")
          ? [0, "judge", 1]
          : [0, 1];
      return stages.map((stage) => ({
        phase: `v${version}-${phase}`,
        stage,
        model: ["once", "once-again", "deny", "always", "follow"].includes(
          phase,
        )
          ? "alternate"
          : "default",
      }));
    }),
  );
}
test("each protocol must use its chosen model and execute both Smart judgments", () => {
  verifyModelRequests(requests(), "default", "alternate");
  const wrong = requests().map((item) =>
    item.phase === "v2-once" ? { ...item, model: "default" } : item,
  );
  assert.throws(
    () => verifyModelRequests(wrong, "default", "alternate"),
    /incorrect model/,
  );
  for (const version of [1, 2])
    for (const phase of ["judge-safe", "judge-ask"]) {
      const missing = requests().filter(
        (item) =>
          !(item.phase === `v${version}-${phase}` && item.stage === "judge"),
      );
      assert.throws(
        () => verifyModelRequests(missing, "default", "alternate"),
        /incorrect model stages/,
      );
    }
});
