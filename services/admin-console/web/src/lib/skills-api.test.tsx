import { expect, it } from "vitest";
import { api, resetSessionRequests } from "./api.ts";

it("Skill upload keeps its key after uncertain failure and sends multipart without a JSON content type", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    clear: () => values.clear(),
    get length() { return values.size; },
  } as Storage;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { dispatchEvent() {} } });
  resetSessionRequests({ organization_id: "org-1", user_id: "user-1", membership_id: "member-1" });
  const keys: string[] = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    expect(input).toBe("/api/admin/skills");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBeNull();
    expect(init?.body).toBeInstanceOf(FormData);
    expect(((init?.body as FormData).get("artifact") as File).name).toBe("review.zip");
    keys.push(headers.get("Idempotency-Key")!);
    return keys.length === 1
      ? Response.json({ code: "temporarily_unavailable", message: "Try again" }, { status: 503 })
      : Response.json({ skill_id: "skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", version: 1, name: "review" }, { status: 201 });
  };
  try {
    const file = new File(["synthetic bytes"], "review.zip", { type: "application/zip" });
    await expect(api.publishSkill(file)).rejects.toThrow();
    await api.publishSkill(file);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(values.size).toBe(0);
  } finally { globalThis.fetch = oldFetch; }
});
