import { PassThrough } from "node:stream";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { AgentChooser } from "./components/AgentChooser";
import { AccountFooter } from "./components/AccountFooter";
import { workspaceFromBridgeBootstrap } from "./lib/bootstrap";
import { renderWorkspaceDocument } from "./ssr-document";

const name = "研发 · Équipe 🚀 <script>alert('display')</script>";
const bootstrap = {
  principal: { userId: "user", organizationId: "org", organizationSlug: "engineering", organizationName: name, administrator: false },
  agents: [{ agentId: "agent", name: "Research", lifecycle: "created", activation: "enabled", runtime: "available" }],
  renderedAt: "2026-10-02T00:00:00Z", bridgeEpoch: "epoch",
};

test("chooser and account footer render the same verified Organization name as escaped text", () => {
  const workspace = workspaceFromBridgeBootstrap(bootstrap);
  const chooser = renderToString(<AgentChooser workspace={workspace} onSelect={() => {}} onLogout={() => {}} logoutDisabled={false} onRefresh={() => {}} refreshing={false} />);
  const footer = renderToString(<AccountFooter principal={workspace.principal} onLogout={() => {}} logoutDisabled={false} />);
  for (const html of [chooser, footer]) {
    expect(html).toContain("研发 · Équipe 🚀");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("Organization workspace");
    expect(html).not.toContain("Open Control Center");
  }
});

test("production SSR renders and serializes the same verified name before hydration", async () => {
  const output = new PassThrough(); let html = "";
  output.setEncoding("utf8"); output.on("data", (chunk: string) => { html += chunk; });
  await renderWorkspaceDocument(output, { bootstrap, route: { agentId: "", sessionId: null }, nonce: "nonce",
    script: "/workspace/assets/app.js", stylesheet: "/workspace/assets/app.css" });
  expect(html).toContain("研发 · Équipe 🚀");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("data-ssr=\"fallback\"");
  expect(html).not.toContain("Organization workspace");
  const payload = JSON.parse(html.match(/id="workspace-bootstrap"[^>]*>(.*?)<\/script>/s)![1]);
  expect(payload.bootstrap.principal.organizationName).toBe(name);
});
