export type SkillSummary = {
  skill_id: string;
  name: string;
  current_version: number;
  description: string;
  artifact_digest: string;
  content_digest: string;
  artifact_size: number;
  unpacked_size: number;
  package_rules_version: number;
};

export type SkillVersion = Omit<SkillSummary, "current_version"> & { version: number };

export type SkillReference = { skill_id: string; version: number };
export type FrozenSkill = SkillVersion;

export type SkillPage = { items: SkillSummary[]; next_after_id: string | null };
export type SkillVersionPage = { items: SkillVersion[]; next_after_version: number | null };

export type AgentSkillSourceRef = { kind: "agent"; agent_id: string; name: string; sequence: number };
export type SkillSource = { skill_ref: AgentSkillSourceRef; name: string; description: string; content_digest: string };
export type SkillSourcePage = { items: SkillSource[] };
export type SkillSourceSelection = { skill_ref: AgentSkillSourceRef; expected_digest: string };
export type SkillSourcePromotion = SkillSourceSelection & { skill_id?: string; expected_version?: number };
export type SkillSourcePreview = {
  skill_ref: AgentSkillSourceRef;
  content_digest: string;
  skill_md: string;
  files: { path: string; size: number; executable: boolean }[];
};
