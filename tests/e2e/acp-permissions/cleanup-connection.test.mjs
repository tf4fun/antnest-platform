import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import {
  commandFixture,
  principal,
} from "../acp-commands/connection.fixture.mjs";
import { summarizeFailure } from "../../support/verification/failure.mjs";
import * as implementation from "./cleanup.mjs";

const { RequestError } = await import("@agentclientprotocol/sdk");
const { withPrivateCommandResources } =
  await import("../acp-commands/connection.mjs");
const entry = () => {
  assert.equal(typeof implementation.closePermissionSessions, "function");
  return implementation.closePermissionSessions;
};
async function joined(f) {
  await Promise.all(
    [...f.sockets.clients].map((socket) => once(socket, "close")),
  );
  assert.equal(f.sockets.clients.size, 0);
}
function close(f, clients, options = {}) {
  return implementation.closePermissionSessions("agent", f.browser, {
    ...f.options,
    clients,
    ...options,
  });
}

test("independent cleanup delegates the original owner and waits for paged Session close replies before joining private TCP", async (t) => {
  entry();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const f = await commandFixture(
    t,
    { version: 1 },
    {
      listSessions: ({ params }) =>
        params.cursor
          ? { sessions: [{ sessionId: "second", cwd: "/workspace" }] }
          : {
              sessions: [{ sessionId: "first", cwd: "/workspace" }],
              nextCursor: "next",
            },
      closeSession: async ({ params }) => {
        if (params.sessionId === "first") {
          entered.resolve();
          await release.promise;
        }
        return {};
      },
    },
  );
  const clients = new Set();
  let settled = false;
  const pending = withPrivateCommandResources(clients, f.telemetry, () =>
    close(f, clients),
  );
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => assert.fail("did not await Session close")),
    ]);
    assert.equal(settled, false);
    assert.equal(f.sockets.clients.size, 1);
  } finally {
    release.resolve();
  }
  assert.equal(await pending, 2);
  await joined(f);
  assert.equal(clients.size, 0);
  assert.deepEqual(
    f.calls.map((row) => row.method),
    [
      "initialize",
      "session/list",
      "session/close",
      "session/list",
      "session/close",
    ],
  );
  assert.deepEqual(
    f.calls
      .filter((row) => row.method === "session/close")
      .map((row) => row.params.sessionId),
    ["first", "second"],
  );
  assert.equal(f.identities.length, 1);
  assert.deepEqual(f.identities[0].body, {
    access_token: f.browser.accessToken,
    profile: "workspace",
    agent_id: "agent",
  });
  assert.equal(f.identities[0].headers.cookie, undefined);
  assert.equal(f.wire.length, 1);
  assert.equal(f.wire[0].method, "UPGRADE");
  assert.equal(f.wire[0].path, "/v1/acp");
  assert.equal(f.wire[0].headers.cookie, undefined);
  assert.match(
    f.wire[0].headers["antnest-caller-context"],
    /^PRIVATE-COMMAND-CCT\./u,
  );
  assert.equal(
    f.wire[0].headers["antnest-service-authorization"],
    `Bearer ${"W".repeat(43)}`,
  );
  const telemetry = JSON.stringify(f.exports);
  for (const secret of [
    f.browser.accessToken,
    ...f.contexts,
    "G".repeat(43),
    "W".repeat(43),
  ])
    assert(!telemetry.includes(secret));
});

for (const mode of ["missing login Principal", "foreign delegated Principal"])
  test(`independent cleanup refuses ${mode} before opening private ACP`, async (t) => {
    entry();
    const f = await commandFixture(
      t,
      { version: 1 },
      { identityPrincipal: () => ({ ...principal, user_id: "foreign" }) },
    );
    const clients = new Set();
    await assert.rejects(
      withPrivateCommandResources(clients, f.telemetry, () =>
        close(
          f,
          clients,
          mode === "missing login Principal" ? { principal: undefined } : {},
        ),
      ),
    );
    assert.equal(f.wire.length, 0);
    assert.deepEqual(f.calls, []);
    assert.equal(clients.size, 0);
  });

for (const mode of [
  "list",
  "close",
  "repeated cursor",
  "page limit",
  "business and telemetry cleanup",
])
  test(`independent cleanup preserves ${mode} failure and joins private TCP`, async (t) => {
    entry();
    let pages = 0;
    const original = new RequestError(-32603, "PRIVATE-CLEANUP-ERROR", {
      code: "cleanup_refused",
    });
    const cleanupError = new Error("PRIVATE-TELEMETRY-CLEANUP");
    const f = await commandFixture(
      t,
      { version: 1 },
      {
        listSessions: () => {
          pages++;
          if (mode === "list") throw original;
          if (mode === "repeated cursor")
            return { sessions: [], nextCursor: "same" };
          if (mode === "page limit")
            return { sessions: [], nextCursor: `page-${pages}` };
          return { sessions: [{ sessionId: "failed", cwd: "/workspace" }] };
        },
        closeSession: () => {
          throw original;
        },
      },
    );
    const clients = new Set();
    const telemetry =
      mode === "business and telemetry cleanup"
        ? {
            shutdown: async () => {
              await f.telemetry.shutdown();
              throw cleanupError;
            },
          }
        : f.telemetry;
    await assert.rejects(
      withPrivateCommandResources(clients, telemetry, () => close(f, clients)),
      (error) => {
        if (mode === "business and telemetry cleanup") {
          assert(error instanceof AggregateError);
          assert.equal(error.errors[0].code, original.code);
          assert.deepEqual(error.errors[0].data, original.data);
          assert.equal(error.errors[1], cleanupError);
        } else if (["list", "close"].includes(mode)) {
          assert.equal(error.code, original.code);
          assert.deepEqual(error.data, original.data);
        } else
          assert.match(
            error.message,
            mode === "page limit" ? /page limit/u : /cursor repeated/u,
          );
        const summary = JSON.stringify(summarizeFailure(error));
        assert(!summary.includes("PRIVATE-"));
        return true;
      },
    );
    await joined(f);
    assert.equal(clients.size, 0);
    if (mode === "repeated cursor") assert.equal(pages, 2);
    if (mode === "page limit") assert.equal(pages, 100);
  });
