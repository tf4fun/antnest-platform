import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RegistrySkillDiscoveryClient } from "../../src/adapters/skill-discovery-http.js";
import { learningSkillTextPackage } from "../../src/domain/learning-candidate-package.js";
import { packageWithFiles, packageWithFilesDigest } from "../fixtures/skill-discovery-package.js";

const base = { organization_id: `org_${"1".repeat(32)}`, actor_id: `user_${"2".repeat(32)}` };
const searchScope = { ...base, requesting_agent_id: `agent_${"5".repeat(32)}` };
const ref = {
  kind: "agent" as const,
  agent_id: `agent_${"3".repeat(32)}`,
  name: "test-skill",
  sequence: 1,
};
const text = '---\nname: "test-skill"\ndescription: "A procedure"\n---\nRead the output.\n';
const pkg = learningSkillTextPackage(text);
const selected = { ...base, skill_ref: ref, expected_digest: pkg.targetDigest };
function response(body: Buffer = pkg.artifact, patches?: Record<string, string>) {
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": "application/zip",
      "content-length": String(body.length),
      etag: `"${hash(body)}"`,
      "x-antnest-artifact-digest": hash(body),
      "x-antnest-content-digest": pkg.targetDigest,
      ...patches,
    },
  });
}
function hash(body: Buffer) {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}
function fixture(reply: Response) {
  const fetch = vi.fn(() => Promise.resolve(reply));
  return {
    fetch,
    client: new RegistrySkillDiscoveryClient(
      "http://registry:8080",
      "private-registry-token",
      fetch,
    ),
  };
}

describe("bounded Registry discovery client", () => {
  it("sends trusted caller, tenant and actor input to a configured origin and refuses redirects", async () => {
    const item = {
      skill_ref: ref,
      name: ref.name,
      description: "A procedure",
      content_digest: pkg.targetDigest,
    };
    const f = fixture(Response.json({ items: [item] }));
    expect(
      await f.client.search(
        { ...searchScope, query: "procedure", limit: 3 },
        new AbortController().signal,
      ),
    ).toEqual({ items: [item] });
    expect(f.fetch).toHaveBeenCalledWith(
      "http://registry:8080/internal/skill-discovery/search",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({ ...searchScope, query: "procedure", limit: 3 }),
      }),
    );
  });

  it("returns exact verified text and both digests from a stored one-file ZIP", async () => {
    const f = fixture(response());
    expect(await f.client.load(selected, new AbortController().signal)).toEqual({
      skillText: text,
      artifactDigest: pkg.artifactDigest,
      contentDigest: pkg.targetDigest,
      requiresRuntimeDelivery: false,
    });
    expect(f.fetch).toHaveBeenCalledWith(
      "http://registry:8080/internal/skill-discovery/load",
      expect.objectContaining({ body: JSON.stringify(selected) }),
    );
  });

  it("keeps verified multi-file bytes only for request-local Runtime delivery", async () => {
    const f = fixture(
      response(packageWithFiles, { "x-antnest-content-digest": packageWithFilesDigest }),
    );
    const value = await f.client.load(
      {
        ...base,
        skill_ref: { kind: "registry", skill_id: `skill_${"4".repeat(32)}`, version: 1 },
        expected_digest: packageWithFilesDigest,
      },
      new AbortController().signal,
    );
    expect(value).toMatchObject({
      contentDigest: packageWithFilesDigest,
      requiresRuntimeDelivery: true,
    });
    expect(value.skillText).toContain("Use the steps.");
    expect(value.artifact).toEqual(packageWithFiles);
  });

  it.each([
    { "content-type": "text/html" },
    { "content-length": "999" },
    { etag: '"wrong"' },
    { "x-antnest-artifact-digest": `sha256:${"f".repeat(64)}` },
    { "x-antnest-content-digest": `sha256:${"e".repeat(64)}` },
  ])("rejects inconsistent response headers %j", async (patch) => {
    const f = fixture(response(pkg.artifact, patch));
    await expect(f.client.load(selected, new AbortController().signal)).rejects.toMatchObject({
      code: "source_invalid",
    });
  });

  it("recomputes the complete manifest instead of trusting a matching content header", async () => {
    const changed = learningSkillTextPackage(text + "Changed.\n");
    const f = fixture(response(changed.artifact));
    await expect(f.client.load(selected, new AbortController().signal)).rejects.toMatchObject({
      code: "source_invalid",
    });
  });

  it.each([
    [404, "not_found"],
    [409, "content_changed"],
    [502, "source_invalid"],
    [503, "source_unavailable"],
  ] as const)("sanitizes HTTP %s as %s", async (status, code) => {
    const f = fixture(new Response("private token and upstream body", { status }));
    await expect(f.client.load(selected, new AbortController().signal)).rejects.toMatchObject({
      code,
    });
  });

  it.each([
    { items: [{ name: "missing fields" }] },
    { items: [], url: "http://caller-controlled" },
  ])("rejects unexpected search metadata %j", async (value) => {
    const f = fixture(Response.json(value));
    await expect(
      f.client.search({ ...searchScope, query: "x" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "source_invalid" });
  });

  it("cancels an oversized streaming body instead of retaining unbounded bytes", async () => {
    const cancel = vi.fn();
    const f = fixture(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(128 * 1024 + 1));
          },
          cancel,
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      f.client.search({ ...searchScope, query: "x" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "source_invalid" });
    expect(cancel).toHaveBeenCalled();
  });

  it("does not send a cancelled request", async () => {
    const f = fixture(response());
    await expect(f.client.load(selected, AbortSignal.abort())).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
