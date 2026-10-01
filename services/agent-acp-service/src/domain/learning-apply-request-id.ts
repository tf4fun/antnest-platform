import { createHash } from "node:crypto";

import type { LearningTaskClaim } from "./learning-scan.js";

export function learningApplyRequestId(
  claim: LearningTaskClaim,
  candidateId: string,
  action: "prepare" | "check" | "commit",
  attempt = 1,
): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new Error("Invalid learning apply attempt number");
  return createHash("sha256")
    .update(
      JSON.stringify([
        "learning-apply-v1",
        claim.taskId,
        claim.claimId,
        claim.generation,
        candidateId,
        action,
        ...(attempt === 1 ? [] : [attempt]),
      ]),
    )
    .digest("hex");
}
