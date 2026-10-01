import { createHash } from "node:crypto";

export type LearningEvidenceItem = {
  evidenceId: string;
  sourceId: string;
  kind: "authenticated_user" | "observed_execution" | "untrusted_material";
  scope: "user_prompt" | "tool_attempt" | "tool_output";
  text: string;
};

export type LearningEvidence = {
  sourceRunId: string;
  items: LearningEvidenceItem[];
  truncated: boolean;
};

export function digestLearningEvidence(evidence: LearningEvidence): string {
  return createHash("sha256")
    .update(JSON.stringify([evidence.sourceRunId, evidence.items, evidence.truncated]))
    .digest("hex");
}
