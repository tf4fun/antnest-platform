import { afterEach, expect, it, vi } from "vitest";
import { api, resetSessionRequests } from "./api";

afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

const selection = { skill_ref: { kind: "agent" as const, agent_id: "agent_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "code-review", sequence: 2 }, expected_digest: `sha256:${"b".repeat(64)}` };

it("promotion retains a command key for the exact reviewed selection after an uncertain response", async () => {
  resetSessionRequests({ organization_id: "org-1", user_id: "user-1", membership_id: "member-1" });
  const requests: { key: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    expect(input).toBe("/api/admin/skill-sources/promote");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    requests.push({ key: headers.get("Idempotency-Key")!, body: JSON.parse(init.body) });
    return requests.length === 1 ? Response.json({ code: "source_unavailable", message: "Try again" }, { status: 503 }) : Response.json({ version: 1 }, { status: 201 });
  }));
  await expect(api.promoteSkillSource(selection)).rejects.toThrow();
  await api.promoteSkillSource(selection);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]?.body).toEqual(selection);
  expect(sessionStorage.length).toBe(0);
});

it("a changed digest, target or authenticated principal never reuses an uncertain promotion", async () => {
  resetSessionRequests({ organization_id: "org-1", user_id: "user-1", membership_id: "member-1" });
  const keys: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
    keys.push(new Headers(init.headers).get("Idempotency-Key")!);
    return Response.json({ code: "source_unavailable", message: "Try again" }, { status: 503 });
  }));
  await expect(api.promoteSkillSource(selection)).rejects.toThrow();
  await expect(api.promoteSkillSource({ ...selection, expected_digest: `sha256:${"c".repeat(64)}` })).rejects.toThrow();
  await expect(api.promoteSkillSource({ ...selection, skill_id: "skill_dddddddddddddddddddddddddddddddd", expected_version: 2 })).rejects.toThrow();
  resetSessionRequests({ organization_id: "org-1", user_id: "user-2", membership_id: "member-2" });
  await expect(api.promoteSkillSource(selection)).rejects.toThrow();
  expect(new Set(keys).size).toBe(4);
});

it("a deterministic source conflict clears the old command and preview carries no publication key", async () => {
  const keys: (string | null)[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    keys.push(new Headers(init.headers).get("Idempotency-Key"));
    return input === "/api/admin/skill-sources/preview" ? Response.json({ skill_md: "Text" }) : Response.json({ code: "content_changed", message: "Choose again" }, { status: 409 });
  }));
  await expect(api.promoteSkillSource(selection)).rejects.toThrow();
  await expect(api.promoteSkillSource(selection)).rejects.toThrow();
  await api.previewSkillSource(selection);
  expect(keys[0]).not.toBe(keys[1]);
  expect(keys[2]).toBeNull();
});
