import assert from "node:assert/strict";

export function verifyModelRequests(requests, defaultModel, alternateModel) {
  for (const version of [1, 2]) {
    for (const phase of [
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
    ]) {
      const observed = requests.filter(
        (request) => request.phase === `v${version}-${phase}`,
      );
      const stages =
        phase === "cancel" || phase === "chat"
          ? [0]
          : phase.startsWith("judge-")
            ? [0, "judge", 1]
            : [0, 1];
      assert.deepEqual(
        observed.map((request) => request.stage),
        stages,
        `incorrect model stages: v${version}-${phase}`,
      );
      const model = ["once", "once-again", "deny", "always", "follow"].includes(
        phase,
      )
        ? alternateModel
        : defaultModel;
      for (const request of observed)
        assert.equal(
          request.model,
          model,
          `incorrect model: v${version}-${phase}`,
        );
    }
  }
  assert.equal(requests.length, 52);
}

export function assertApprovalPending(params, updates, sessionId, decision) {
  assert.equal(params.sessionId, sessionId);
  const tool = params.toolCall ?? params.subject?.toolCall;
  assert(tool?.rawInput, "exact arguments missing");
  assert(
    !updates.some((frame) =>
      ["tool_call", "tool_call_update"].includes(frame.update.sessionUpdate),
    ),
    "dispatch before approval",
  );
  assert(
    params.options.some((option) => option.optionId === decision),
    "permission option missing",
  );
}
