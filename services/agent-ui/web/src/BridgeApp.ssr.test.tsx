import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import BridgeApp from "./BridgeApp";

const bootstrap = (userId: string, agentId: string) => ({
  principal: { organizationSlug: "engineering", organizationName: "Engineering", userId, organizationId: "org-1", administrator: false },
  agents: [{ agentId, name: `Agent ${agentId}`, lifecycle: "created",
    activation: "enabled", runtime: "available" }],
  renderedAt: "2026-09-23T00:00:00Z", bridgeEpoch: "epoch-1",
});

test("Bridge SSR seeds only the request's authorized Agent navigation", () => {
  const first = renderToString(<BridgeApp initialBootstrap={bootstrap("user-1", "one")}
    initialRoute={{ agentId: "one", sessionId: null }} />);
  const second = renderToString(<BridgeApp initialBootstrap={bootstrap("user-2", "two")}
    initialRoute={{ agentId: "two", sessionId: null }} />);
  expect(first).toContain("Agent one");
  expect(first).not.toContain("Agent two");
  expect(second).toContain("Agent two");
  expect(second).not.toContain("Agent one");
});
