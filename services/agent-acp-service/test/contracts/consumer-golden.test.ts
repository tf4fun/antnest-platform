import { describe, expect, it } from "vitest";

import { ControllerLearningPolicyClient } from "../../src/adapters/controller-learning-policy.js";
import { parseExecutionAuthority } from "../../src/domain/execution-publication-v2.js";

interface SharedGoldenHelpers {
  loadGolden: (area: string, file: string) => unknown;
  withFutureFields: (value: unknown) => unknown;
}

const helpers = (await import(
  new URL("../../../../tests/support/contracts/golden.mjs", import.meta.url).href
)) as SharedGoldenHelpers;
const { loadGolden, withFutureFields } = helpers;

const snapshots = [
  "execution-snapshot.n-1-ready.json",
  "execution-snapshot.n-1-preparing.json",
  "execution-snapshot.ready.json",
  "execution-snapshot.preparing.json",
  "execution-snapshot.v2.json",
] as const;

describe("Agent Controller execution snapshot consumers", () => {
  for (const file of snapshots) {
    it(`consumes the real ${file} producer document and ignores recursive extensions`, () => {
      const document = loadGolden("agent-acp", file) as Record<string, unknown>;
      const baseline = parseExecutionAuthority(document);
      const extended = parseExecutionAuthority(withFutureFields(document));
      expect(extended).toEqual(baseline);
      expect(baseline.organization_id).toBe(document.organization_id);
      expect(baseline.revision).toBe(document.revision);
      const providers = baseline.providers as Array<{ credential?: unknown }>;
      expect(providers).toHaveLength((document.providers as unknown[]).length);
      expect(providers[0]?.credential).toEqual(
        file === "execution-snapshot.v2.json"
          ? { ref: "provider-1", version: "credential-current" }
          : { method: "api_key", secret: "synthetic-current-secret" },
      );
      expect((baseline.models as unknown[]).length).toBeGreaterThan(0);
      expect((baseline.agents as unknown[]).length).toBeGreaterThan(0);
    });
  }

  it("rejects invalid known fields even when extensions are present", () => {
    const document = loadGolden("agent-acp", "execution-snapshot.ready.json") as Record<
      string,
      unknown
    >;
    const providers = document.providers as Array<Record<string, unknown>>;
    const invalid = [
      { ...document, schema_version: 99 },
      { ...document, revision: 0 },
      Object.fromEntries(Object.entries(document).filter(([key]) => key !== "organization_id")),
      { ...document, providers: [{ ...providers[0]!, base_url: 443 }, ...providers.slice(1)] },
    ];
    for (const input of invalid) {
      expect(() => parseExecutionAuthority(withFutureFields(input))).toThrow();
    }
  });
});

describe("Controller learning policy consumer", () => {
  const scope = { organizationId: "org-1", agentId: "agent-1", ownerId: "owner-1" };
  const policy = loadGolden("skill-learning", "learning-policy.automatic.json") as Record<
    string,
    unknown
  >;

  const serve = (body: unknown) =>
    new ControllerLearningPolicyClient("http://controller:8080", () =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
    );

  it("decodes the real Controller capture and ignores recursive extensions", async () => {
    const baseline = await serve(policy).read(scope);
    const extended = await serve(withFutureFields(policy)).read(scope);
    expect(extended).toEqual(baseline);
    expect(baseline.organization_id).toBe("org-1");
    expect(baseline.agent_id).toBe("agent-1");
    expect(baseline.owner_principal_id).toBe("owner-1");
    expect(baseline.mode).toBe("automatic");
    expect(baseline.limits.daily_reviews).toBeGreaterThan(0);
  });

  it("rejects another scope or invalid known fields even with extensions", async () => {
    const invalid = [
      { ...policy, agent_id: "agent-2" },
      Object.fromEntries(Object.entries(policy).filter(([key]) => key !== "revision")),
      { ...policy, limits: { ...(policy.limits as Record<string, unknown>), daily_reviews: -1 } },
    ];
    for (const body of invalid) {
      await expect(serve(withFutureFields(body)).read(scope)).rejects.toThrow();
    }
  });
});
