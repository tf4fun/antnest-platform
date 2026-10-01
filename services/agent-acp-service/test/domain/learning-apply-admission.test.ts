import { describe, expect, it } from "vitest";

import { admitAutomaticSkillCandidate } from "../../src/domain/learning-apply-admission.js";
import { buildLearningCandidatePackage } from "../../src/domain/learning-candidate-package.js";
import type { LearningPolicy } from "../../src/domain/learning-policy.js";
import type { RuntimeInformation } from "../../src/domain/runtime-information.js";
import type { LearningTaskClaim } from "../../src/domain/learning-scan.js";

const evidenceId = `evidence_${"e".repeat(32)}`;
const candidate = buildLearningCandidatePackage(
  {
    decision: "propose",
    name: "inspect-first",
    description: "Inspect first.",
    instructions: "unused",
    rules: [{ text: "Inspect first", evidenceIds: [evidenceId] }],
  },
  {
    sourceRunId: "run-1",
    truncated: false,
    items: [
      {
        evidenceId,
        sourceId: "user-1",
        kind: "authenticated_user",
        scope: "user_prompt",
        text: "Inspect first",
      },
    ],
  },
);
const policy: LearningPolicy = {
  organization_id: "org-1",
  agent_id: "agent-1",
  owner_principal_id: "owner-1",
  revision: "a".repeat(64),
  activation_cut_at: "2026-09-29T00:00:00Z",
  mode: "automatic",
  scope: { auto_generated_personal: true, adopted_paths: [] },
  pinned_paths: [],
  limits: { daily_reviews: 20, daily_model_input_tokens: 320000, daily_model_output_tokens: 80000 },
};
const claim: LearningTaskClaim = {
  taskId: "task-1",
  claimId: "claim-1",
  generation: 1,
  organizationId: "org-1",
  agentId: "agent-1",
  ownerId: "owner-1",
  sourceRunId: "run-1",
  frozenPolicy: policy,
};
const information: RuntimeInformation = {
  executionId: "execution-1",
  environment: { os: "linux", arch: "x64", home: "/workspace", workspace: "/workspace" },
  instructions: null,
  skills: [],
  warnings: [],
  truncated: false,
};
const input = {
  claim,
  policy,
  candidate,
  expectedBaseDigest: null,
  managed: null,
  information,
  executionId: "execution-1",
};
const active = {
  organizationId: claim.organizationId,
  agentId: claim.agentId,
  ownerId: claim.ownerId,
  packagePath: candidate.packagePath,
  origin: "auto_generated" as const,
  state: "active" as const,
  lastDigest: candidate.targetDigest,
};
const personal = {
  source: "personal" as const,
  name: "inspect-first",
  description: "Inspect first.",
  path: { root: "workspace" as const, path: `${candidate.packagePath}/SKILL.md` },
};

describe("automatic Skill apply admission", () => {
  it("admits a new personal Skill only under the current automatic policy and complete inventory", () => {
    expect(admitAutomaticSkillCandidate(input)).toEqual({
      kind: "policy",
      policyRevision: policy.revision,
      packagePath: candidate.packagePath,
      expectedBaseDigest: null,
      targetDigest: candidate.targetDigest,
      evidenceIds: [evidenceId],
      executionId: "execution-1",
    });
  });

  it("rejects a hidden name collision, system name collision, warnings and capacity uncertainty", () => {
    for (const changed of [
      { information: { ...information, skills: [personal] } },
      {
        information: {
          ...information,
          skills: [
            {
              ...personal,
              source: "system" as const,
              path: { root: "system_skills" as const, path: "inspect-first/SKILL.md" },
            },
          ],
        },
      },
      {
        information: {
          ...information,
          warnings: [
            {
              path: { root: "workspace" as const, path: candidate.packagePath },
              code: "invalid_skill" as const,
            },
          ],
        },
      },
      { information: { ...information, truncated: true } },
      { policy: { ...policy, scope: { ...policy.scope, adopted_paths: [candidate.packagePath] } } },
      {
        information: {
          ...information,
          skills: Array.from({ length: 32 }, (_, index) => ({
            source: "personal" as const,
            name: `other-${index}`,
            description: "Other",
            path: { root: "workspace" as const, path: `.antnest/skills/other-${index}/SKILL.md` },
          })),
        },
      },
    ])
      expect(() => admitAutomaticSkillCandidate({ ...input, ...changed })).toThrow();
  });

  it("updates only a registered unpinned path with the exact saved base and visible personal identity", () => {
    const updated = {
      ...input,
      managed: active,
      expectedBaseDigest: active.lastDigest,
      information: { ...information, skills: [personal] },
    };
    expect(admitAutomaticSkillCandidate(updated)).toMatchObject({
      expectedBaseDigest: active.lastDigest,
    });
    for (const changed of [
      { managed: null },
      { expectedBaseDigest: `sha256:${"b".repeat(64)}` },
      { policy: { ...policy, pinned_paths: [candidate.packagePath] } },
      { policy: { ...policy, revision: "b".repeat(64) } },
      { information },
      { managed: { ...active, state: "paused" as const } },
    ])
      expect(() => admitAutomaticSkillCandidate({ ...updated, ...changed })).toThrow();
  });

  it("rejects adopted managed paths while adoption is deferred", () => {
    const adopted = { ...active, origin: "adopted" as const };
    const updating = {
      ...input,
      managed: adopted,
      expectedBaseDigest: adopted.lastDigest,
      information: { ...information, skills: [personal] },
    };
    expect(() => admitAutomaticSkillCandidate(updating)).toThrow();
    expect(() =>
      admitAutomaticSkillCandidate({
        ...updating,
        policy: {
          ...policy,
          scope: { ...policy.scope, adopted_paths: [candidate.packagePath] },
        },
      }),
    ).toThrow();
  });

  it("rejects off policy, owner drift and Runtime execution drift", () => {
    for (const changed of [
      { policy: { ...policy, mode: "off" as const } },
      { policy: { ...policy, owner_principal_id: "other" } },
      { information: { ...information, executionId: "execution-2" } },
      { executionId: "execution-2" },
    ])
      expect(() => admitAutomaticSkillCandidate({ ...input, ...changed })).toThrow();
  });
});
