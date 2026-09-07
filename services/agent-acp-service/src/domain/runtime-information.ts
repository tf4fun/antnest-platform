export type RuntimePath = { root: "workspace" | "system_skills"; path: string };

export type RuntimeInformation = {
  executionId: string;
  environment: { os: string; arch: string; home: string; workspace: string };
  instructions: { path: RuntimePath; content: string; truncated: boolean } | null;
  skills: { source: "system" | "personal"; name: string; description: string; path: RuntimePath }[];
  warnings: {
    path: RuntimePath;
    code:
      "unreadable" | "invalid_utf8" | "invalid_skill" | "too_large" | "scan_limit" | "skill_limit";
  }[];
  truncated: boolean;
};
