import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { renderWorkspaceDocument } from "./ssr-document";

async function documentFor(bootstrap: unknown): Promise<string> {
  const output = new PassThrough();
  let html = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => { html += chunk; });
  await renderWorkspaceDocument(output, {
    bootstrap,
    route: { agentId: "agent-1", sessionId: null },
    nonce: "nonce-1",
    script: "/workspace/assets/entry-client.js",
    stylesheet: "/workspace/assets/style.css",
  });
  return html;
}

test("SSR document keeps each request's bootstrap and safely serializes script text", async () => {
  const first = await documentFor({
    principal: { organizationSlug: "engineering", organizationName: "Engineering", userId: "user-one", organizationId: "org", administrator: false },
    agents: [{ agentId: "agent-1", name: "<script>alert(1)</script>", lifecycle: "created", activation: "enabled", runtime: "available" }],
    renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch",
  });
  const second = await documentFor({
    principal: { organizationSlug: "engineering", organizationName: "Engineering", userId: "user-two", organizationId: "org", administrator: false },
    agents: [{ agentId: "agent-1", name: "Agent two", lifecycle: "created", activation: "enabled", runtime: "available" }],
    renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch",
  });
  expect(first).toContain("user-one");
  expect(first).not.toContain("user-two");
  expect(first).not.toContain("<script>alert(1)</script>");
  expect(first).toContain("\\u003cscript\\u003e");
  expect(second).toContain("Agent two");
  expect(second).not.toContain("user-one");
  expect(first).toContain('nonce="nonce-1"');
});

test("failed SSR returns a client-mountable shell without serializing invalid bootstrap", async () => {
  const html = await documentFor({ invalid: "bootstrap" });
  expect(html).toContain('<div id="root" data-ssr="fallback">');
  expect(html).toContain('<p role="status">Opening workspace</p>');
  expect(html).toContain('"bootstrap":null');
  expect(html).not.toContain('"invalid"');
  expect(html).toContain('src="/workspace/assets/entry-client.js"');
});

test("closing the document stream settles server rendering", async () => {
  const output = new PassThrough();
  output.on("data", () => output.destroy());
  const rendering = renderWorkspaceDocument(output, {
    bootstrap: undefined,
    route: { agentId: "", sessionId: null },
    nonce: "nonce-1",
    script: "/workspace/assets/entry-client.js",
    stylesheet: "/workspace/assets/style.css",
  });
  const outcome = await Promise.race([
    rendering.then(() => "settled"),
    new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 100)),
  ]);
  expect(outcome).toBe("settled");
});
