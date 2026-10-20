import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium } from "../../../services/agent-ui/web/node_modules/playwright/index.mjs";
import { view } from "../edge-gateway/resolve-cache-stream-fixtures.mjs";
import { readC4View } from "./c4-view.mjs";

let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
});
after(async () => {
  await browser?.close();
});

async function fixture(t, reply) {
  const wire = [];
  const server = createServer((request, response) => {
    wire.push({ path: request.url, cookie: request.headers.cookie });
    if (request.url.startsWith("/api/app/agents/")) {
      response.writeHead(404).end();
      return;
    }
    const { status = 200, body } = reply;
    response
      .writeHead(status, { "content-type": "application/json" })
      .end(JSON.stringify(body));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const gateway = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext();
  t.after(() => context.close());
  await context.addCookies([
    {
      name: "antnest_session",
      value: "ORIGINAL-C4-BROWSER-SESSION",
      url: gateway,
      secure: true,
    },
    {
      name: "antnest_csrf",
      value: "ORIGINAL-C4-CSRF",
      url: gateway,
      secure: true,
    },
  ]);
  return { gateway, context, wire };
}

for (const sessionId of [null, "session-1", "session/?&=1"])
  test(`C4 reads the current Bridge view for ${sessionId ?? "a draft"} with its original browser session`, async (t) => {
    const body = view(sessionId, "cursor");
    const { gateway, context, wire } = await fixture(t, { body });
    const frames = [];
    assert.deepEqual(
      await readC4View(context, {
        gateway,
        agentId: "agent-1",
        sessionId,
        frames,
      }),
      body,
    );
    assert.equal(wire.length, 1);
    const target = new URL(wire[0].path, gateway);
    assert.equal(target.pathname, "/api/app/workspace/v1/agents/agent-1/view");
    assert.equal(target.searchParams.get("sessionId"), sessionId);
    assert.equal(
      wire[0].cookie,
      "antnest_session=ORIGINAL-C4-BROWSER-SESSION; antnest_csrf=ORIGINAL-C4-CSRF",
    );
    assert.deepEqual(frames, [JSON.stringify(body)]);
    assert.equal(Object.hasOwn(body, "configuration_revision"), false);
  });

for (const [name, change] of [
  [
    "foreign Agent",
    (body) => {
      body.agentId = "foreign";
      body.selectedView.agentId = "foreign";
    },
  ],
  [
    "foreign selected Session",
    (body) => {
      body.selectedSessionId = "foreign";
      body.selectedView.sessionId = "foreign";
    },
  ],
  [
    "inconsistent selected Session",
    (body) => {
      body.selectedView.sessionId = "foreign";
    },
  ],
  [
    "private state mixed into the Bridge view",
    (body) => {
      body.configuration_revision = "a".repeat(64);
    },
  ],
  [
    "malformed availability",
    (body) => {
      body.availability = "available";
    },
  ],
  [
    "retired state DTO",
    (body) => {
      for (const key of Object.keys(body)) delete body[key];
      Object.assign(body, {
        agent_id: "agent-1",
        access_allowed: true,
        availability: "ready",
        configuration_revision: "a".repeat(64),
        active_session_id: null,
        unavailable_reason: null,
      });
    },
  ],
])
  test(`C4 rejects a ${name} returned from the current Bridge route`, async (t) => {
    const body = view("session-1", "cursor");
    change(body);
    const { gateway, context, wire } = await fixture(t, { body });
    const frames = [];
    await assert.rejects(
      readC4View(context, {
        gateway,
        agentId: "agent-1",
        sessionId: "session-1",
        frames,
      }),
    );
    assert(wire[0].path.startsWith("/api/app/workspace/v1/"));
    assert.deepEqual(
      frames,
      [JSON.stringify(body)],
      "retain the failing response for private diagnostics",
    );
  });

test("C4 never treats Bridge unavailability as a usable view", async (t) => {
  const { gateway, context } = await fixture(t, {
    status: 503,
    body: { code: "unavailable" },
  });
  await assert.rejects(
    readC4View(context, { gateway, agentId: "agent-1" }),
    /503/,
  );
});

test("C4 preserves the original browser request failure", async () => {
  const failure = new Error("original browser transport failure");
  const context = {
    cookies: async () => [{ name: "antnest_csrf", value: "csrf" }],
    request: {
      fetch: async () => {
        throw failure;
      },
    },
  };
  await assert.rejects(
    readC4View(context, {
      gateway: "https://gateway.invalid",
      agentId: "agent-1",
    }),
    (error) => error === failure,
  );
});
