import { z } from "zod";

import type { LearningEvidence } from "./learning-evidence.js";

const EVIDENCE_ID = /^evidence_[0-9a-f]{32}$/u;

const ruleSchema = z.strictObject({
  text: z.string().trim().min(1).max(2_048),
  evidenceIds: z
    .array(z.string().regex(EVIDENCE_ID))
    .min(1)
    .max(64)
    .refine((ids) => new Set(ids).size === ids.length),
});

export type LearningRuleProposal = z.infer<typeof ruleSchema>;

// Necessary source/identity check only. It does not prove that a cited fact
// supports the rule's meaning or authorize candidate application.
export function checkAutomaticCitationFloor(
  rulesInput: unknown,
  evidence: LearningEvidence,
): LearningRuleProposal[] {
  const rules = z.array(ruleSchema).min(1).max(32).parse(rulesInput);
  if (evidence.sourceRunId === "" || evidence.items.length > 64)
    throw new Error("Learning evidence snapshot is invalid");
  const byId = new Map(evidence.items.map((item) => [item.evidenceId, item]));
  if (byId.size !== evidence.items.length)
    throw new Error("Learning evidence snapshot contains duplicate identities");
  for (const rule of rules) {
    const cited = rule.evidenceIds.map((id) => {
      const item = byId.get(id);
      if (item === undefined) throw new Error("Learning rule cites evidence outside its source");
      return item;
    });
    if (
      !cited.some(
        (item) => item.kind === "authenticated_user" || item.kind === "observed_execution",
      )
    )
      throw new Error("Automatic Skill rule lacks a trusted source");
  }
  return rules;
}
