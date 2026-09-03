import type { Overview } from "./types";

export type SetupStepKey = "models" | "templates" | "directory" | "agents";
export type SetupStepState = "ready" | "needed" | "blocked" | "unavailable";

export type SetupStep = {
  key: SetupStepKey;
  label: string;
  href: string;
  state: SetupStepState;
  count: number | null;
  summary: string;
  action: string;
};

export type SetupGuidance = {
  steps: SetupStep[];
  next?: SetupStep;
  complete: boolean;
};

export type CreationGate = {
  allowed: boolean;
  message?: string;
  href?: string;
  action?: string;
};

export function platformSetup(overview: Overview): SetupGuidance {
  const modelHasMore = overview.model_profiles.status === "available"
    && Boolean(overview.model_profiles.data.next_after_id);
  const modelCount = overview.model_profiles.status === "available"
    ? overview.model_profiles.data.items.filter((item) => item.enabled).length
    : null;
  const templateHasMore = overview.templates.status === "available"
    && Boolean(overview.templates.data.next_after_id);
  const templateCount = overview.templates.status === "available"
    ? overview.templates.data.items.filter((item) => item.enabled).length
    : null;
  const memberCount = overview.directory.status === "available"
    ? overview.directory.data.users.filter(
      ({ user, membership }) => user.active && membership.active,
    ).length
    : null;
  const agentCount = overview.agents.status === "available"
    ? overview.agents.data.items.filter((item) => item.desired_state !== "deleted").length
    : null;
  const agentHasMore = overview.agents.status === "available"
    && Boolean(overview.agents.data.next_cursor);

  const steps: SetupStep[] = [
    resourceStep({
      key: "models",
      label: "Model provider",
      href: "#models",
      count: modelCount,
      hasMore: modelHasMore,
      readyUnit: "enabled",
      emptySummary: "Connect a model and credential",
      moreSummary: "Review remaining profiles for an enabled model",
      unavailableSummary: "Model catalog unavailable",
      action: modelCount === null
        ? "Retry model providers"
        : modelCount === 0 && modelHasMore
        ? "Review model providers"
        : "Add model provider",
    }),
    dependentStep({
      key: "templates",
      label: "Agent template",
      href: "#templates",
      count: templateCount,
      hasMore: templateHasMore,
      readyUnit: "enabled",
      dependencyReady: modelCount !== null && modelCount > 0,
      emptySummary: "Define model and runtime defaults",
      moreSummary: "Review remaining templates for an enabled definition",
      blockedSummary: "Requires a model provider",
      unavailableSummary: "Template catalog unavailable",
      action: templateCount === null
        ? "Retry Agent templates"
        : templateCount === 0 && templateHasMore
        ? "Review Agent templates"
        : "Create Agent template",
    }),
    resourceStep({
      key: "directory",
      label: "Directory member",
      href: "#directory",
      count: memberCount,
      emptySummary: "Add an active Agent owner",
      unavailableSummary: "Directory unavailable",
      action: memberCount === null ? "Retry directory" : "Add directory member",
    }),
    dependentStep({
      key: "agents",
      label: "Agent",
      href: "#agents",
      count: agentCount,
      hasMore: agentHasMore,
      dependencyReady:
        templateCount !== null && templateCount > 0 && memberCount !== null && memberCount > 0,
      emptySummary: "Build the first executable Agent",
      moreSummary: "Review the remaining Agent inventory",
      blockedSummary: "Requires a template and active owner",
      unavailableSummary: "Agent inventory unavailable",
      action: agentCount === null ? "Retry Agent inventory" : "Create Agent",
    }),
  ];
  const next = steps.find((step) => step.state === "needed" || step.state === "unavailable");

  return {
    steps,
    next,
    complete: steps.every((step) => step.state === "ready"),
  };
}

export function templateCreationGate(input: {
  modelsAvailable?: boolean;
  modelsRetryable?: boolean;
  modelCount: number;
  modelsHaveMore?: boolean;
  defaultsAvailable?: boolean;
  defaultsRetryable?: boolean;
}): CreationGate {
  if (input.modelsAvailable === undefined || input.defaultsAvailable === undefined) {
    return {
      allowed: false,
      message: "Loading model and Runtime defaults.",
    };
  }
  if (!input.modelsAvailable) {
    if (input.modelsRetryable === false) {
      return {
        allowed: false,
        message: "Model provider data is unavailable. Resolve the reported issue before creating a template.",
      };
    }
    return {
      allowed: false,
      message: "Model provider data is unavailable. Retry before creating a template.",
      action: "Retry model choices",
    };
  }
  if (!input.defaultsAvailable) {
    if (input.defaultsRetryable === false) {
      return {
        allowed: false,
        message: "Runtime defaults are unavailable. Resolve the reported issue before creating a template.",
      };
    }
    return {
      allowed: false,
      message: "Runtime defaults are unavailable. Retry before creating a template.",
      action: "Retry Runtime defaults",
    };
  }
  if (input.modelCount === 0 && !input.modelsHaveMore) {
    return {
      allowed: false,
      message: "Connect a model provider before creating an Agent template.",
      href: "#models",
      action: "Add model provider",
    };
  }
  return { allowed: true };
}

export function agentCreationGate(input: {
  templatesAvailable?: boolean;
  templatesRetryable?: boolean;
  templateCount: number;
  templatesHaveMore?: boolean;
  directoryAvailable?: boolean;
  directoryRetryable?: boolean;
  memberCount: number;
}): CreationGate {
  if (input.templatesAvailable === undefined || input.directoryAvailable === undefined) {
    return {
      allowed: false,
      message: "Loading template and directory options.",
    };
  }
  if (!input.templatesAvailable) {
    if (input.templatesRetryable === false) {
      return {
        allowed: false,
        message: "Template data is unavailable. Resolve the reported issue before creating an Agent.",
      };
    }
    return {
      allowed: false,
      message: "Template data is unavailable. Retry before creating an Agent.",
      action: "Retry template choices",
    };
  }
  if (!input.directoryAvailable) {
    if (input.directoryRetryable === false) {
      return {
        allowed: false,
        message: "Directory data is unavailable. Resolve the reported issue before creating an Agent.",
      };
    }
    return {
      allowed: false,
      message: "Directory data is unavailable. Retry before creating an Agent.",
      action: "Retry directory",
    };
  }
  if (input.templateCount === 0 && !input.templatesHaveMore) {
    return {
      allowed: false,
      message: "Create an Agent template before building an Agent.",
      href: "#templates",
      action: "Create Agent template",
    };
  }
  if (input.memberCount === 0) {
    return {
      allowed: false,
      message: "Add an active directory member to own the Agent.",
      href: "#directory",
      action: "Add directory member",
    };
  }
  return { allowed: true };
}

function resourceStep(input: {
  key: SetupStepKey;
  label: string;
  href: string;
  count: number | null;
  hasMore?: boolean;
  readyUnit?: string;
  emptySummary: string;
  moreSummary?: string;
  unavailableSummary: string;
  action: string;
}): SetupStep {
  if (input.count === null) {
    return { ...input, state: "unavailable", summary: input.unavailableSummary };
  }
  return {
    ...input,
    state: input.count > 0 ? "ready" : "needed",
    summary: input.count > 0
      ? readySummary(input.count, input.readyUnit, input.hasMore)
      : input.hasMore
      ? input.moreSummary ?? input.emptySummary
      : input.emptySummary,
  };
}

function dependentStep(input: {
  key: SetupStepKey;
  label: string;
  href: string;
  count: number | null;
  hasMore?: boolean;
  readyUnit?: string;
  dependencyReady: boolean;
  emptySummary: string;
  moreSummary?: string;
  blockedSummary: string;
  unavailableSummary: string;
  action: string;
}): SetupStep {
  if (input.count === null) {
    return { ...input, state: "unavailable", summary: input.unavailableSummary };
  }
  if (input.count > 0) {
    return {
      ...input,
      state: "ready",
      summary: readySummary(input.count, input.readyUnit, input.hasMore),
    };
  }
  return {
    ...input,
    state: input.dependencyReady ? "needed" : "blocked",
    summary: input.dependencyReady
      ? input.hasMore
        ? input.moreSummary ?? input.emptySummary
        : input.emptySummary
      : input.blockedSummary,
  };
}

function readySummary(count: number, unit = "configured", hasMore = false): string {
  return hasMore ? `At least ${count} ${unit}` : `${count} ${unit}`;
}
