import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  stage2ConnectionFixture,
  principal,
} from "./stage2-private-connection.fixture.mjs";
const url = new URL("./stage2-private-access.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});

async function fixture(t, options = {}) {
  assert.equal(typeof implementation.createStage2PrivateAccess, "function");
  const f = await stage2ConnectionFixture(t, options);
  const directory = await mkdtemp(join(tmpdir(), "stage2-private-access-"));
  for (const [path, value] of [
    ["edge-gateway/tokens/identity-service", "G"],
    ["agent-ui/tokens/agent-acp-service", "W"],
  ]) {
    await mkdir(join(directory, path, ".."), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, path), value.repeat(43), { mode: 0o600 });
  }
  t.after(() => rm(directory, { recursive: true, force: true }));
  const access = f.register(
    await implementation.createStage2PrivateAccess(
      {
        evidence: join(directory, "evidence"),
        privateAccess: {
          acp: f.origin,
          identity: f.origin,
          otlp: f.origin + "/v1/traces",
          credentials: directory,
        },
      },
      { secrets: [] },
    ),
  );
  return { ...f, access };
}

test(
  "Stage2 uses original Identity authority for v2, complete state and fresh watch snapshots",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      a = f.access;
    const client = await a.open("agent", f.browser, principal);
    await client.newSession();
    assert.deepEqual(await a.state("agent", f.browser, principal), f.state);
    assert.deepEqual(
      await a.firstState("agent", f.browser, principal),
      f.state,
    );
    f.state.configuration_revision = "b".repeat(64);
    assert.deepEqual(
      await a.firstState("agent", f.browser, principal),
      f.state,
    );
    await a.closeAndWait();
    assert.equal(f.identities.length, 4);
    assert(
      f.identities.every(
        (row) =>
          row.body.access_token === f.browser.accessToken &&
          row.body.agent_id === "agent",
      ),
    );
    assert.equal(a.snapshots().length, 1);
    assert.equal(a.snapshots()[0].version, 2);
    assert.equal(a.stateReceipts()[0].status, 200);
    assert.equal(a.watchSnapshots().length, 2);
    assert(
      a
        .watchSnapshots()
        .every((row) => row.joined && row.body_outcome === "cancelled"),
    );
    assert(
      a
        .authoritySnapshots()
        .every(
          (scope) =>
            scope.receipts.length === 1 && scope.receipts[0].client_ended,
        ),
    );
    assert(
      f.privateRequests.every(
        (row) => row.method === "POST" && row.headers.cookie === undefined,
      ),
    );
  },
);

test(
  "Stage2 cold state retains the exact original 503 without treating expected recovery as cleanup failure",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    f.setCold(true);
    const value = await f.access.state("agent", f.browser, principal);
    assert.deepEqual(value, {
      code: "execution_state_unavailable",
      message: "Agent execution state is unavailable",
      retryable: true,
    });
    await f.access.closeAndWait();
    const [row] = f.access.stateReceipts();
    assert.equal(row.status, 503);
    assert.equal(row.joined, true);
    assert.equal(row.body_outcome, "eof");
    assert.deepEqual(
      JSON.parse(Buffer.from(row.raw_body_base64, "base64")),
      value,
    );
    assert.match(
      row.errors.join("\n"),
      /PrivateACPExecutionStateUnavailableError/u,
    );
  },
);

test(
  "Stage2 revocation observes the original watch EOF, existing Prompt denial and fresh Identity 401",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      a = f.access;
    const client = await a.open("agent", f.browser, principal);
    const { sessionId } = await client.newSession();
    const watch = await a.watch("agent", f.browser, principal);
    await watch.wait((state) => state.access_allowed);
    const start = watch.beginRevocation();
    f.revoke();
    await watch.wait((state) => !state.access_allowed);
    await watch.waitClosed();
    await client.denied(sessionId, ["access_denied"]);
    const denied = await a.denyNewConnection("agent", f.browser, principal, {
      after: start.observedAt,
    });
    assert.equal(denied.status, 401);
    assert.equal(f.upgrades.length, 1);
    await a.closeAndWait();
    assert.equal(a.watchSnapshots()[0].body_outcome, "eof");
    assert.equal(
      a.watchSnapshots()[0].revocation_start.observedAt,
      start.observedAt,
    );
  },
);

test(
  "Stage2 v1 HTTP retains history and re-resolves each real request through joined DELETE",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      a = f.access;
    const socket = await a.open("agent", f.browser, principal);
    const { sessionId } = await socket.newSession();
    f.setHTTPOffline(true);
    const http = await a.openHTTP("agent", f.browser, principal);
    const listed = await http.request("list", {});
    assert(listed.sessions.some((row) => row.sessionId === sessionId));
    await http.request("load", {
      sessionId,
      cwd: "/workspace",
      mcpServers: [],
    });
    await assert.rejects(
      http.request("prompt", {
        sessionId,
        prompt: [{ type: "text", text: "must not execute" }],
      }),
      (error) => error.data?.code === "agent_unavailable",
    );
    f.setHTTPOffline(false);
    await http.prompt();
    await http.closeAndWait();
    await a.closeAndWait();
    const [snapshot] = a.httpSnapshots();
    assert.equal(snapshot.closed, true);
    assert.equal(snapshot.http.streamJoined, true);
    assert.equal(snapshot.http.pendingRequests, 0);
    assert(snapshot.http.requests.some((row) => row.method === "GET"));
    assert(
      snapshot.http.requests.some(
        (row) =>
          row.method === "DELETE" &&
          row.status === 202 &&
          row.bodyOutcome === "eof",
      ),
    );
    assert.equal(snapshot.authority.length, snapshot.http.requests.length);
    assert(
      snapshot.authority.every((row) => row.status === 200 && row.client_ended),
    );
    assert.deepEqual(
      snapshot.evidence.map((row) => row.method),
      [
        "session/list",
        "session/load",
        "session/prompt",
        "session/new",
        "session/prompt",
      ],
    );
    assert.equal(
      snapshot.evidence[2].rejectionReceipt.code,
      "agent_unavailable",
    );
    const actual = f.privateRequests.filter((row) => row.path === "/v1/acp");
    assert.equal(actual.length, snapshot.http.requests.length);
    assert.equal(f.identities.length, actual.length + 1);
  },
);

test(
  "Stage2 rejects all new operations while an original HTTP DELETE is still joining",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { holdDelete: true }),
      a = f.access;
    const http = await a.openHTTP("agent", f.browser, principal);
    await http.request("list", {});
    const closing = a.closeAndWait();
    void closing.catch(() => {});
    await f.deleteEntered;
    const before = f.identities.length;
    try {
      for (const method of [
        "open",
        "state",
        "watch",
        "firstState",
        "openHTTP",
        "denyNewConnection",
        "flush",
      ])
        await assert.rejects(
          async () =>
            a[method]("agent", f.browser, principal, { after: Date.now() }),
          /closing/u,
        );
      assert.equal(f.identities.length, before);
    } finally {
      f.releaseDelete();
      await closing;
    }
    assert.equal(a.httpSnapshots()[0].http.pendingRequests, 0);
  },
);

test(
  "Stage2 joins the original GET Resolve cancelled by local HTTP close and retains its diagnostic",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { holdResolve: 2 }),
      a = f.access;
    const http = await a.openHTTP("agent", f.browser, principal);
    await f.resolveEntered;
    await http.closeAndWait();
    await a.closeAndWait();
    const [snapshot] = a.httpSnapshots();
    assert.equal(snapshot.closed, true);
    assert.deepEqual(snapshot.http.failures, []);
    assert.equal(snapshot.http.pendingRequests, 0);
    const cancelled = snapshot.http.requests.filter(
      (row) => row.bodyOutcome === "cancelled" && !row.wireStarted,
    );
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].method, "GET");
    assert.equal(snapshot.authority_cancellations.length, 1);
    const receipt =
      snapshot.authority[snapshot.authority_cancellations[0].authority_index];
    assert.equal(receipt.body_outcome, "failed");
    assert.equal(receipt.client_ended, true);
    assert.match(receipt.errors.join("\n"), /AbortError/u);
    assert.equal(
      snapshot.authority_cancellations[0].http_request_index,
      cancelled[0].index,
    );
  },
);
