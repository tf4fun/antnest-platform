import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCreationGate,
  platformSetup,
  templateCreationGate,
} from "./setup.ts";
import type {
  Agent,
  AgentTemplate,
  Directory,
  ModelProfile,
  Overview,
  OverviewSection,
} from "./types.ts";

function available<T>(data: T): OverviewSection<T> {
  return { status: "available", data };
}

function overview(input: {
  members?: number;
  models?: number;
  modelsEnabled?: boolean;
  moreModels?: boolean;
  templates?: number;
  templatesEnabled?: boolean;
  moreTemplates?: boolean;
  agents?: number;
  moreAgents?: boolean;
  unavailable?: "directory" | "model_profiles" | "templates" | "agents";
} = {}): Overview {
  const members = Array.from({ length: input.members ?? 0 }, (_, index) => ({
    user: {
      id: `user-${index}`,
      system_role: "member",
      active: true,
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:00Z",
    },
    membership: {
      id: `membership-${index}`,
      user_id: `user-${index}`,
      email: `user-${index}@example.com`,
      display_name: `User ${index}`,
      role: "member" as const,
      source: "local" as const,
      active: true,
      created_at: "2026-09-03T00:00:00Z",
      updated_at: "2026-09-03T00:00:00Z",
    },
  }));
  const models = Array.from({ length: input.models ?? 0 }, (_, index) => ({
    model_profile_id: `model-${index}`,
    display_name: `Model ${index}`,
    revision_id: `model-revision-${index}`,
    revision: 1,
    enabled: input.modelsEnabled ?? true,
    model: {
      base_url: "https://models.example.com/v1",
      model: `model-${index}`,
      context_window: 8192,
      max_output_tokens: 1024,
      supports_images: false,
    },
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
  })) satisfies ModelProfile[];
  const templates = Array.from({ length: input.templates ?? 0 }, (_, index) => ({
    template_id: `template-${index}`,
    name: `Template ${index}`,
    revision: 1,
    model_profile_id: "model-0",
    system_prompt: "",
    max_model_requests: 32,
    context_policy_version: "v1",
    runtime: {
      image_ref: "antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      resources: { memory_bytes: 1, pids_limit: 1, tmpfs_bytes: 1 },
    },
    skill_refs: [],
    enabled: input.templatesEnabled ?? true,
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
  })) satisfies AgentTemplate[];
  const agents = Array.from({ length: input.agents ?? 0 }, (_, index) => ({
    agent_id: `agent-${index}`,
    owner_user_id: "user-0",
    name: `Agent ${index}`,
    desired_state: "enabled",
    lifecycle_state: "created", activation_state: "enabled", runtime_state: "available",
    aggregate_sequence: 1,
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
  })) satisfies Agent[];
  const unavailable = <T>(name: string): OverviewSection<T> => ({
    status: "unavailable",
    error: { status: 503, code: `${name}_unavailable`, message: `${name} unavailable` },
  });

  return {
    directory: input.unavailable === "directory"
      ? unavailable<Directory>("directory")
      : available({ users: members, groups: [] }),
    model_profiles: input.unavailable === "model_profiles"
      ? unavailable<{ items: ModelProfile[]; next_after_id?: string | null }>("models")
      : available({ items: models, next_after_id: input.moreModels ? "next-model" : null }),
    templates: input.unavailable === "templates"
      ? unavailable<{ items: AgentTemplate[]; next_after_id?: string | null }>("templates")
      : available({ items: templates, next_after_id: input.moreTemplates ? "next-template" : null }),
    agents: input.unavailable === "agents"
      ? unavailable<{ items: Agent[]; next_cursor?: string | null }>("agents")
      : available({ items: agents, next_cursor: input.moreAgents ? "next-agent" : null }),
    defaults: { runtime_image_ref: "" },
  };
}

test("setup guidance advances through the minimum administrator path", () => {
  assert.equal(platformSetup(overview()).next?.key, "models");
  assert.equal(platformSetup(overview({ models: 1 })).next?.key, "templates");
  assert.equal(platformSetup(overview({ models: 1, templates: 1 })).next?.key, "directory");
  assert.equal(
    platformSetup(overview({ models: 1, templates: 1, members: 1 })).next?.key,
    "agents",
  );
  assert.equal(
    platformSetup(overview({ models: 1, templates: 1, members: 1, agents: 1 })).complete,
    true,
  );
});

test("setup guidance keeps unavailable authority distinct from an empty catalog", () => {
  const setup = platformSetup(overview({ unavailable: "model_profiles" }));

  assert.equal(setup.steps[0]?.state, "unavailable");
  assert.equal(setup.steps[0]?.count, null);
  assert.equal(setup.next?.action, "Retry model providers");
});

test("setup guidance describes paged readiness counts as lower bounds", () => {
  const setup = platformSetup(overview({
    members: 1,
    models: 1,
    moreModels: true,
    templates: 1,
    moreTemplates: true,
    agents: 1,
    moreAgents: true,
  }));

  assert.deepEqual(
    setup.steps.map((step) => step.summary),
    ["At least 1 enabled", "At least 1 enabled", "1 configured", "At least 1 configured"],
  );
});

test("setup guidance asks for review when a partial catalog page has no enabled item", () => {
  const setup = platformSetup(overview({
    models: 1,
    modelsEnabled: false,
    moreModels: true,
  }));

  assert.equal(setup.steps[0]?.state, "needed");
  assert.equal(setup.steps[0]?.summary, "Review remaining profiles for an enabled model");
  assert.equal(setup.steps[0]?.action, "Review model providers");
});

test("template creation points to the missing model dependency", () => {
  assert.deepEqual(templateCreationGate({
    modelsAvailable: true,
    modelCount: 0,
    defaultsAvailable: true,
  }), {
    allowed: false,
    message: "Connect a model provider before creating an Agent template.",
    href: "#models",
    action: "Add model provider",
  });
  assert.equal(templateCreationGate({
    modelsAvailable: true,
    modelCount: 1,
    defaultsAvailable: true,
  }).allowed, true);
  assert.equal(templateCreationGate({
    modelsAvailable: true,
    modelCount: 0,
    modelsHaveMore: true,
    defaultsAvailable: true,
  }).allowed, true);
});

test("template creation distinguishes loading and unavailable dependencies", () => {
  assert.deepEqual(templateCreationGate({
    modelCount: 0,
    defaultsAvailable: true,
  }), {
    allowed: false,
    message: "Loading model and Runtime defaults.",
  });
  assert.deepEqual(templateCreationGate({
    modelsAvailable: true,
    modelCount: 1,
    defaultsAvailable: false,
  }), {
    allowed: false,
    message: "Runtime defaults are unavailable. Retry before creating a template.",
    action: "Retry Runtime defaults",
  });
  assert.deepEqual(templateCreationGate({
    modelsAvailable: false,
    modelsRetryable: false,
    modelCount: 0,
    defaultsAvailable: true,
  }), {
    allowed: false,
    message: "Model provider data is unavailable. Resolve the reported issue before creating a template.",
  });
  assert.deepEqual(templateCreationGate({
    modelsAvailable: true,
    modelCount: 1,
    defaultsAvailable: false,
    defaultsRetryable: false,
  }), {
    allowed: false,
    message: "Runtime defaults are unavailable. Resolve the reported issue before creating a template.",
  });
});

test("template creation permits a tag choice without a platform default", () => {
  const gate = templateCreationGate({
    modelsAvailable: true, modelCount: 1,
    defaultsAvailable: true,
  });
  assert.equal(gate.allowed, true);
  assert.equal(gate.action, undefined);
});

test("Agent creation explains unavailable and missing dependencies in order", () => {
  assert.deepEqual(
    agentCreationGate({ templatesAvailable: false, templateCount: 0, directoryAvailable: true, memberCount: 1 }),
    {
      allowed: false,
      message: "Template data is unavailable. Retry before creating an Agent.",
      action: "Retry template choices",
    },
  );
  assert.equal(
    agentCreationGate({ templatesAvailable: true, templateCount: 0, directoryAvailable: true, memberCount: 0 }).href,
    "#templates",
  );
  assert.equal(
    agentCreationGate({ templatesAvailable: true, templateCount: 1, directoryAvailable: true, memberCount: 0 }).href,
    "#directory",
  );
  assert.equal(
    agentCreationGate({ templatesAvailable: true, templateCount: 1, directoryAvailable: true, memberCount: 1 }).allowed,
    true,
  );
  assert.equal(
    agentCreationGate({
      templatesAvailable: true,
      templateCount: 0,
      templatesHaveMore: true,
      directoryAvailable: true,
      memberCount: 1,
    }).allowed,
    true,
  );
  assert.deepEqual(
    agentCreationGate({ templatesAvailable: undefined, templateCount: 0, directoryAvailable: true, memberCount: 1 }),
    {
      allowed: false,
      message: "Loading template and directory options.",
    },
  );
  assert.deepEqual(
    agentCreationGate({
      templatesAvailable: false,
      templatesRetryable: false,
      templateCount: 0,
      directoryAvailable: true,
      memberCount: 1,
    }),
    {
      allowed: false,
      message: "Template data is unavailable. Resolve the reported issue before creating an Agent.",
    },
  );
  assert.deepEqual(
    agentCreationGate({
      templatesAvailable: true,
      templateCount: 1,
      directoryAvailable: false,
      directoryRetryable: false,
      memberCount: 0,
    }),
    {
      allowed: false,
      message: "Directory data is unavailable. Resolve the reported issue before creating an Agent.",
    },
  );
});
