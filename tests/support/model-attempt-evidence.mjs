import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

const date = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

// These business profiles complete their original primary-model calls without
// retries. Older captures predate the hidden journal; when present, require its
// complete receipts without changing visible history or the existing usage gate.
export function assertCompletedModelAttempts(run, events) {
  const attempts = events.filter((event) => event.kind === "model_attempt");
  if (attempts.length === 0) return;
  const usage = events.filter((event) => event.kind === "usage");
  assert(
    usage.length > 0 && attempts.length === usage.length * 2,
    "Complete hidden model attempt pairs required",
  );
  const snapshot = run.execution_snapshot;
  for (const [index, receipt] of usage.entries()) {
    const start = attempts[index * 2];
    const finish = attempts[index * 2 + 1];
    for (const event of [start, finish])
      assert(
        event.visible === false &&
          (event.context_excluded === undefined ||
            event.context_excluded === true),
        "Model attempt became visible or entered model context",
      );
    assert(
      start.payload.phase === "start" &&
        finish.payload.phase === "finish" &&
        start.payload.ordinal === index + 1 &&
        finish.payload.ordinal === index + 1,
      "Hidden model attempt phases or ordinals changed",
    );
    assert(
      start.sequence < finish.sequence &&
        finish.sequence < receipt.sequence &&
        (index === 0 || usage[index - 1].sequence < start.sequence),
      "Hidden model attempt is not followed by its original usage receipt",
    );
    assert(
      start.payload.purpose === "foreground" &&
        start.payload.modelProfileId === snapshot.modelProfileId &&
        start.payload.providerConnectionId === snapshot.providerConnectionId &&
        start.payload.model === snapshot.executionSpec.model.model,
      "Model attempt differs from its frozen primary candidate",
    );
    assert(
      date(start.payload.startedAt) &&
        date(finish.payload.finishedAt) &&
        Date.parse(finish.payload.finishedAt) >=
          Date.parse(start.payload.startedAt) &&
        Number.isFinite(finish.payload.durationMs) &&
        finish.payload.durationMs >= 0,
      "Invalid hidden model attempt time or duration",
    );
    assert(
      finish.payload.outcome === "completed" &&
        finish.payload.reason === "completed" &&
        finish.payload.outputStarted === true,
      "Original model attempt did not complete with output",
    );
    assert(
      finish.payload.contextSize ===
        snapshot.executionSpec.model.contextWindow &&
        finish.payload.contextSize === receipt.payload.size &&
        isDeepStrictEqual(finish.payload.usage, receipt.payload.measurement),
      "Model attempt usage or context differs from its original receipt",
    );
  }
}
