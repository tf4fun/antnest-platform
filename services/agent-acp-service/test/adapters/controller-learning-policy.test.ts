import { describe, expect, it, vi } from "vitest";

import { ControllerLearningPolicyClient } from "../../src/adapters/controller-learning-policy.js";

const scope = {
  organizationId: "org-learning",
  agentId: "agent-learning",
  ownerId: "owner-learning",
};
const policy = {
  organization_id: scope.organizationId,
  agent_id: scope.agentId,
  owner_principal_id: scope.ownerId,
  revision: "a".repeat(64),
  activation_cut_at: "2026-09-29T07:00:01.123456Z",
  mode: "automatic",
  scope: { auto_generated_personal: true, adopted_paths: [] },
  pinned_paths: [],
  limits: {
    daily_reviews: 20,
    daily_model_input_tokens: 320000,
    daily_model_output_tokens: 80000,
  },
};

describe("Controller Skill learning policy read", () => {
  it("uses only the trusted scope and preserves the exact activation cut", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(JSON.stringify(policy), { status: 200 })),
    );
    const client = new ControllerLearningPolicyClient("http://controller:8080", fetcher);
    expect(await client.read(scope)).toEqual(policy);
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      "http://controller:8080/internal/agents/agent-learning/skill-learning-policy?organization_id=org-learning&principal_id=owner-learning",
    );
    expect(request).toMatchObject({ method: "GET", credentials: "omit" });
  });

  it("rejects a policy for another owner, malformed cut, or extra authority fields", async () => {
    for (const body of [
      { ...policy, owner_principal_id: "other-owner" },
      { ...policy, activation_cut_at: "2026-09-29T15:00:01+08:00" },
      { ...policy, caller_selected_authority: true },
    ]) {
      const client = new ControllerLearningPolicyClient("http://controller:8080", () =>
        Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
      );
      await expect(client.read(scope)).rejects.toThrow();
    }
  });

  it("keeps authorization loss and temporary failure distinct from an off policy", async () => {
    const denied = new ControllerLearningPolicyClient("http://controller:8080", () =>
      Promise.resolve(new Response(null, { status: 403 })),
    );
    await expect(denied.read(scope)).rejects.toMatchObject({ code: "access_denied" });
    const unavailable = new ControllerLearningPolicyClient("http://controller:8080", () =>
      Promise.resolve(new Response(null, { status: 503 })),
    );
    await expect(unavailable.read(scope)).rejects.toMatchObject({ code: "policy_unavailable" });
    const disabled = new ControllerLearningPolicyClient("http://controller:8080", () =>
      Promise.resolve(new Response(JSON.stringify({ ...policy, mode: "off" }), { status: 200 })),
    );
    await expect(disabled.read(scope)).resolves.toMatchObject({ mode: "off" });
  });

  it("fails closed on a truncated or oversized Controller response", async () => {
    for (const body of ["{", "x".repeat(16 * 1024 + 1)]) {
      const client = new ControllerLearningPolicyClient("http://controller:8080", () =>
        Promise.resolve(new Response(body, { status: 200 })),
      );
      await expect(client.read(scope)).rejects.toMatchObject({ code: "policy_unavailable" });
    }
  });

  it("rejects forged input scope before contacting Controller", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(policy), { status: 200 })),
    );
    const client = new ControllerLearningPolicyClient("http://controller:8080", fetcher);
    await expect(client.read({ ...scope, agentId: "../other" })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
