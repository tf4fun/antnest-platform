import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildLearningCandidatePackage,
  learningSkillTextDigest,
} from "../../src/domain/learning-candidate-package.js";
import type { LearningEvidence } from "../../src/domain/learning-evidence.js";

const evidenceId = `evidence_${"a".repeat(32)}`;
const evidence: LearningEvidence = {
  sourceRunId: "run-1",
  truncated: false,
  items: [
    {
      evidenceId,
      sourceId: "user-1",
      kind: "authenticated_user",
      scope: "user_prompt",
      text: "Inspect before editing",
    },
  ],
};
const decision = {
  decision: "propose" as const,
  name: "inspect-first",
  description: "Inspect a target before editing it.",
  instructions: "This unrelated free text must not enter the Skill body.",
  rules: [{ text: "Inspect before editing", evidenceIds: [evidenceId] }],
};

describe("learning candidate package", () => {
  it("renders only cited rule text into a portable one-file package with stable digests", () => {
    const result = buildLearningCandidatePackage(decision, evidence);
    expect(result.packagePath).toBe(".antnest/skills/inspect-first");
    expect(result.packageRulesVersion).toBe(1);
    expect(result.evidenceIds).toEqual([evidenceId]);
    expect(result.skillText).toContain('name: "inspect-first"');
    expect(result.skillText).toContain("Inspect before editing");
    expect(result.skillText).not.toContain("unrelated free text");
    expect(result.artifact.readUInt32LE(0)).toBe(0x04034b50);
    expect(result.artifact.readUInt32LE(result.artifact.length - 22)).toBe(0x06054b50);
    expect(result.artifactDigest).toBe(
      `sha256:${createHash("sha256").update(result.artifact).digest("hex")}`,
    );
    expect(result.targetDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(buildLearningCandidatePackage(decision, evidence)).toMatchObject({
      targetDigest: result.targetDigest,
      artifactDigest: result.artifactDigest,
    });
  });

  it("rejects a body above the Registry SKILL.md limit and untrusted-only citations", () => {
    expect(() =>
      buildLearningCandidatePackage(
        {
          ...decision,
          rules: [
            { text: "x".repeat(2048), evidenceIds: [evidenceId] },
            ...Array.from({ length: 8 }, () => ({
              text: "y".repeat(2048),
              evidenceIds: [evidenceId],
            })),
          ],
        },
        evidence,
      ),
    ).toThrow();
    expect(() =>
      buildLearningCandidatePackage(decision, {
        ...evidence,
        items: [{ ...evidence.items[0]!, kind: "untrusted_material", scope: "tool_output" }],
      }),
    ).toThrow();
  });

  it("preserves the current Skill when adding a newly evidenced rule", () => {
    const current = [
      "---",
      'name: "inspect-first"',
      'description: "Existing procedure"',
      "---",
      "# inspect-first",
      "",
      "Keep this prior, independently verified rule.",
      "",
    ].join("\n");
    const result = buildLearningCandidatePackage(decision, evidence, {
      skillText: current,
      digest: learningSkillTextDigest(current),
    });
    expect(result.skillText).toContain("Keep this prior, independently verified rule.");
    expect(result.skillText).toContain("Inspect before editing");
    expect(result.skillText).toContain('description: "Existing procedure"');
    expect(result.skillText.startsWith(current)).toBe(true);
  });

  it("rejects an update whose current text, identity or base digest is not established", () => {
    const current = [
      "---",
      'name: "inspect-first"',
      'description: "Existing procedure"',
      "---",
      "# inspect-first",
      "",
    ].join("\n");
    const digest = learningSkillTextDigest(current);
    expect(() =>
      buildLearningCandidatePackage(decision, evidence, {
        skillText: current,
        digest: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow();
    expect(() =>
      buildLearningCandidatePackage(decision, evidence, {
        skillText: current.replace("inspect-first", "other-skill"),
        digest,
      }),
    ).toThrow();
  });
});
