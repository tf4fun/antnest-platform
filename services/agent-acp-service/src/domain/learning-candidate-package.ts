import { createHash } from "node:crypto";

import type { LearningEvidence } from "./learning-evidence.js";
import {
  parseLearningReviewProposal,
  type LearningReviewDecision,
} from "./learning-review-proposal.js";

type Proposal = Extract<LearningReviewDecision, { decision: "propose" }>;

const MAX_SKILL_BYTES = 16 * 1024;
const FILE_NAME = Buffer.from("SKILL.md", "utf8");
const MANIFEST_PREFIX = Buffer.from("antnest-skill-manifest-v1\0", "utf8");

export type LearningCandidatePackage = {
  packagePath: string;
  packageRulesVersion: 1;
  skillText: string;
  artifact: Buffer;
  artifactDigest: string;
  targetDigest: string;
  evidenceIds: string[];
};

export function validateLearningCandidatePackage(value: LearningCandidatePackage): void {
  const body = Buffer.from(value.skillText, "utf8");
  const nameLine = value.skillText.split("\n", 3)[1];
  let name: unknown;
  try {
    name = nameLine?.startsWith("name: ") ? JSON.parse(nameLine.slice(6)) : null;
  } catch {
    throw new Error("Learning candidate name is invalid");
  }
  if (
    typeof name !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) ||
    value.packagePath !== `.antnest/skills/${name}` ||
    !validUtf8(value.skillText) ||
    body.length > MAX_SKILL_BYTES ||
    !value.artifact.equals(storedZip(FILE_NAME, body)) ||
    value.artifactDigest !== digest(value.artifact) ||
    value.targetDigest !== manifestDigest(body) ||
    value.evidenceIds.length < 1 ||
    value.evidenceIds.length > 64 ||
    value.evidenceIds.some((id) => !/^evidence_[0-9a-f]{32}$/u.test(id)) ||
    !value.evidenceIds.every((id, index) => index === 0 || value.evidenceIds[index - 1]! < id)
  )
    throw new Error("Learning candidate package identity or bytes are invalid");
}

// Only individually cited rules become executable Skill guidance. The model's
// free-form `instructions` field remains review text and is never packaged.
export function buildLearningCandidatePackage(
  input: Proposal,
  evidence: LearningEvidence,
  current?: { skillText: string; digest: string },
): LearningCandidatePackage {
  const checked = parseLearningReviewProposal(JSON.stringify(input), evidence);
  if (checked.decision !== "propose") throw new Error("Expected a Skill proposal");
  const addedRules = checked.rules.flatMap((rule) => [rule.text, ""]).join("\n");
  let skillText: string;
  if (current === undefined) {
    skillText = [
      "---",
      `name: ${JSON.stringify(checked.name)}`,
      `description: ${JSON.stringify(checked.description)}`,
      "---",
      `# ${checked.name}`,
      "",
      addedRules,
    ].join("\n");
  } else {
    const lines = current.skillText.split("\n", 4);
    if (
      current.digest !== learningSkillTextDigest(current.skillText) ||
      lines[0] !== "---" ||
      lines[1] !== `name: ${JSON.stringify(checked.name)}` ||
      !/^description: ".*"$/u.test(lines[2] ?? "") ||
      lines[3] !== "---"
    )
      throw new Error("Learning Skill update base is invalid");
    const separator = current.skillText.endsWith("\n\n")
      ? ""
      : current.skillText.endsWith("\n")
        ? "\n"
        : "\n\n";
    skillText = `${current.skillText}${separator}${addedRules}`;
  }
  if (
    !validUtf8(skillText) ||
    [...skillText].some((char) => {
      const code = char.codePointAt(0)!;
      return code < 32 && code !== 9 && code !== 10;
    })
  )
    throw new Error("Learning Skill text contains invalid characters");
  const body = Buffer.from(skillText, "utf8");
  if (body.length > MAX_SKILL_BYTES)
    throw new Error("Learning SKILL.md exceeds Registry package rules");
  const artifact = storedZip(FILE_NAME, body);
  return {
    packagePath: `.antnest/skills/${checked.name}`,
    packageRulesVersion: 1,
    skillText,
    artifact,
    artifactDigest: digest(artifact),
    targetDigest: manifestDigest(body),
    evidenceIds: [...new Set(checked.rules.flatMap((rule) => rule.evidenceIds))].sort(),
  };
}

function validUtf8(value: string): boolean {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function manifestDigest(body: Buffer): string {
  const frame = Buffer.alloc(4 + FILE_NAME.length + 8 + 32 + 1);
  frame.writeUInt32BE(FILE_NAME.length, 0);
  FILE_NAME.copy(frame, 4);
  frame.writeBigUInt64BE(BigInt(body.length), 4 + FILE_NAME.length);
  createHash("sha256")
    .update(body)
    .digest()
    .copy(frame, 4 + FILE_NAME.length + 8);
  frame[frame.length - 1] = 0; // non-executable regular file
  return digest(Buffer.concat([MANIFEST_PREFIX, frame]));
}

export function learningSkillTextDigest(text: string): string {
  if (!validUtf8(text) || Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES)
    throw new Error("Learning Skill text is invalid");
  return manifestDigest(Buffer.from(text, "utf8"));
}

/** ACP-created packages contain exactly one SKILL.md. Retained bytes are usable
 * as a source only after Runtime observes the same complete directory digest. */
export function learningSkillTextPackage(skillText: string): {
  name: string;
  description: string;
  skillText: string;
  artifact: Buffer;
  artifactDigest: string;
  targetDigest: string;
} {
  const lines = skillText.split("\n", 4);
  if (
    lines[0] !== "---" ||
    lines[3] !== "---" ||
    !lines[1]?.startsWith("name: ") ||
    !lines[2]?.startsWith("description: ")
  )
    throw new Error("Source Skill frontmatter is invalid");
  const name: unknown = JSON.parse(lines[1].slice(6));
  const description: unknown = JSON.parse(lines[2].slice(13));
  if (
    typeof name !== "string" ||
    name.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) ||
    typeof description !== "string" ||
    description !== description.trim() ||
    !description.length ||
    Buffer.byteLength(description) > 512 ||
    description.includes("\0")
  )
    throw new Error("Source Skill metadata is invalid");
  const targetDigest = learningSkillTextDigest(skillText);
  const artifact = storedZip(FILE_NAME, Buffer.from(skillText, "utf8"));
  return { name, description, skillText, artifact, artifactDigest: digest(artifact), targetDigest };
}

function storedZip(name: Buffer, body: Buffer): Buffer {
  const crc = crc32(body);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 file name, no encryption
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // DOS origin, ordinary non-executable file
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralOffset = local.length + name.length + body.length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
