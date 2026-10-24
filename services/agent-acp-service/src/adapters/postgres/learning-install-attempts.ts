import { learningApplyRequestId } from "../../domain/learning-apply-request-id.js";
import { installRejectionIsResendable } from "../../domain/learning-maintenance-errors.js";
import type { LearningTaskClaim } from "../../domain/learning-scan.js";

export type InstallAttemptCandidate = {
  package_path: string;
  expected_base_digest: string | null;
  target_digest: string;
};
export type InstallAttemptRow = {
  request_id: string;
  state: "pending" | "unknown" | "settled";
  request_facts: Record<string, unknown>;
  receipt: Record<string, unknown> | null;
};
export type InstallAttemptFinal = "applied" | "conflict" | "rejected";
export type InstallAttemptInspection = {
  kind: "fresh" | InstallAttemptFinal;
  requestId: string;
};

export function inspectInstallAttempts(
  claim: LearningTaskClaim,
  candidateId: string,
  candidate: InstallAttemptCandidate,
  rows: readonly InstallAttemptRow[],
): InstallAttemptInspection {
  const byId = new Map(rows.map((row) => [row.request_id, row]));
  if (byId.size !== rows.length) throw new Error("Duplicate learning install intents");
  let final: InstallAttemptFinal | null = null;
  for (let ordinal = 1; ordinal <= rows.length; ordinal += 1) {
    const row = byId.get(learningApplyRequestId(claim, candidateId, "install", ordinal));
    if (
      !row ||
      row.request_facts.package_path !== candidate.package_path ||
      row.request_facts.expected_base_digest !== candidate.expected_base_digest ||
      row.request_facts.target_digest !== candidate.target_digest
    )
      throw new Error("Learning install intent sequence or target conflicts");
    final = finalOutcome(row);
    if (final !== null && ordinal < rows.length)
      throw new Error("Learning install attempt follows a settled final outcome");
  }
  const last = learningApplyRequestId(claim, candidateId, "install", Math.max(rows.length, 1));
  if (final !== null) return { kind: final, requestId: last };
  const requestId = learningApplyRequestId(claim, candidateId, "install", rows.length + 1);
  return { kind: "fresh", requestId };
}

function finalOutcome(row: InstallAttemptRow): InstallAttemptFinal | null {
  if (row.state !== "settled" || row.receipt === null) return null;
  if (row.receipt.kind === "rejection")
    return typeof row.receipt.code === "string" && installRejectionIsResendable(row.receipt.code)
      ? null
      : "rejected";
  if (row.receipt.outcome === "applied") return "applied";
  if (row.receipt.outcome === "conflict") return "conflict";
  if (row.receipt.outcome === "blocked" || row.receipt.outcome === "preempted") return null;
  throw new Error("Learning install receipt has no known outcome");
}
