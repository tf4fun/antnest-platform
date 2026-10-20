import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = new URL("./health-private-state.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const principal = { organization_id: "org", user_id: "owner" };
const browser = { accessToken: "original-owner-session" };
const initial = {
  agent_id: "agent",
  lifecycle_state: "created",
  activation_state: "enabled",
  desired_state: "enabled",
  runtime_state: "available",
  executable_execution_revision: "exec",
  configuration: { template: { template_id: "template", revision: 1 } },
  runtime: { runtime_revision: "runtime", runtime_execution_id: "process" },
};
async function fixture(t, options = {}) {
  assert.equal(typeof implementation.createHealthStateReader, "function");
  const state = {
    agent_id: "agent",
    access_allowed: true,
    configuration_revision: "a".repeat(64),
    availability: "ready",
    active_session_id: null,
    unavailable_reason: null,
  };
  const requests = [],
    archives = [],
    budgets = [];
  const entered = Promise.withResolvers(),
    disconnected = Promise.withResolvers();
  const deadline = new AbortController(),
    parent = new AbortController();
  const identity = structuredClone(principal);
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({
      path: request.url,
      method: request.method,
      headers: request.headers,
      body,
    });
    if (
      (options.hang === "identity" && request.url.includes("identity")) ||
      (options.hang === "body" && request.url.includes("agent-acp"))
    )
      response.once("close", () => disconnected.resolve());
    if (options.hang === "identity" && request.url.includes("identity")) {
      entered.resolve();
      return;
    }
    if (request.url === "/rpc/identity/resolve-access-token") {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          caller_context: "original-workspace-context",
          principal: identity,
        }),
      );
      return;
    }
    assert.equal(request.url, "/rpc/agent-acp/get-agent-execution-state");
    response.writeHead(options.status ?? 200, {
      "content-type": "application/json",
    });
    if (options.hang === "body") {
      response.write("{");
      entered.resolve();
      return;
    }
    response.end(options.raw ?? JSON.stringify(state));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const credentials = await mkdtemp(join(tmpdir(), "health-state-"));
  t.after(() => rm(credentials, { recursive: true, force: true }));
  for (const [path, value] of [
    ["edge-gateway/tokens/identity-service", "G"],
    ["agent-ui/tokens/agent-acp-service", "W"],
  ]) {
    await mkdir(join(credentials, path, ".."), { recursive: true });
    await writeFile(join(credentials, path), value.repeat(43), { mode: 0o600 });
  }
  const reader = await implementation.createHealthStateReader(
    { healthPrivateAccess: { identity: origin, acp: origin, credentials } },
    {
      signal: parent.signal,
      secrets: [],
      initial,
      timeoutSignal(ms) {
        budgets.push(ms);
        return deadline.signal;
      },
      preserve(value) {
        archives.push(structuredClone(value));
        if (options.archiveError) throw options.archiveError;
      },
    },
  );
  const read = (phase = "recovered", remainingMs = 60000) =>
    reader.read(phase, "agent", browser, principal, remainingMs);
  return {
    state,
    identity,
    reader,
    read,
    requests,
    archives,
    budgets,
    deadline,
    parent,
    entered,
    disconnected,
  };
}

test("Health delegates only the original owner and retains full state before confirming its projection", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.read(), f.state);
  await f.reader.confirm("recovered", initial);
  await f.reader.closeAndWait();
  assert.deepEqual(f.budgets, [15000]);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0].body, {
    access_token: browser.accessToken,
    profile: "workspace",
    agent_id: "agent",
  });
  assert.equal(
    f.requests[0].headers["antnest-service-authorization"],
    `Bearer ${"G".repeat(43)}`,
  );
  assert.equal(
    f.requests[1].headers["antnest-service-authorization"],
    `Bearer ${"W".repeat(43)}`,
  );
  assert.equal(
    f.requests[1].headers["antnest-caller-context"],
    "original-workspace-context",
  );
  assert.equal(f.requests[1].headers.cookie, undefined);
  const last = f.archives.at(-1);
  assert.equal(last.reads[0].phase, "recovered");
  assert.deepEqual(JSON.parse(last.reads[0].rawBody), f.state);
  assert.deepEqual(last.observations, [
    { phase: "recovered", receipt_index: 0, agent: initial },
  ]);
  await assert.rejects(f.read(), /closing/);
});

for (const [name, mutate, expected] of [
  [
    "Principal drift",
    (f) => {
      f.identity.user_id = "foreign";
    },
    /authority changed/,
  ],
  [
    "foreign Agent",
    (f) => {
      f.state.agent_id = "foreign";
    },
    /foreign ACP/,
  ],
  [
    "missing configuration revision",
    (f) => {
      delete f.state.configuration_revision;
    },
    /complete ACP execution state schema/,
  ],
])
  test(`Health rejects ${name} and preserves every received state`, async (t) => {
    const f = await fixture(t);
    mutate(f);
    await assert.rejects(f.read(), expected);
    await assert.rejects(f.reader.closeAndWait(), expected);
    assert.equal(
      f.archives.at(-1).reads.length,
      name === "Principal drift" ? 0 : 1,
    );
    if (name !== "Principal drift")
      assert.deepEqual(JSON.parse(f.archives.at(-1).reads[0].rawBody), f.state);
  });

for (const options of [
  {
    status: 503,
    raw: '{"code":"execution_state_unavailable","message":"Agent execution state is unavailable","retryable":true}',
  },
  { raw: "invalid-private-json" },
])
  test(`Health preserves rejected raw state (${options.status ?? "JSON"})`, async (t) => {
    const f = await fixture(t, options);
    await assert.rejects(f.read());
    await assert.rejects(f.reader.closeAndWait());
    assert.equal(f.archives.at(-1).reads[0].rawBody, options.raw);
  });

for (const hang of ["identity", "body"])
  for (const source of ["deadline", "parent"]) {
    test(`Health joins silent ${hang} on ${source} cancellation with the original reason`, async (t) => {
      const f = await fixture(t, { hang });
      const reason = new Error(`${source} stopped`);
      const operation = f.read("unhealthy", 650);
      const rejection = assert.rejects(operation, (error) => error === reason);
      await f.entered.promise;
      f[source].abort(reason);
      await rejection;
      await assert.rejects(
        f.reader.closeAndWait(),
        (error) => error === reason,
      );
      await f.disconnected.promise;
      assert.deepEqual(f.budgets, [650]);
      assert.equal(f.archives.at(-1).reads.length, 0);
    });
  }

test("Health preserves both state failure and independent archive failure", async (t) => {
  const archive = new Error("private archive failed");
  const f = await fixture(t, {
    archiveError: archive,
    raw: "invalid-private-json",
  });
  await assert.rejects(
    f.read(),
    (error) =>
      error instanceof AggregateError &&
      error.errors.includes(archive) &&
      error.errors.some((e) =>
        /invalid ACP execution state JSON/.test(e.message),
      ),
  );
  await assert.rejects(f.reader.closeAndWait());
  assert.equal(f.archives[0].reads[0].rawBody, "invalid-private-json");
});

test("Health close joins an in-flight response before completing its archive", async (t) => {
  const f = await fixture(t, { hang: "body" });
  const reason = new Error("parent stopped during close");
  const read = assert.rejects(f.read(), (error) => error === reason);
  await f.entered.promise;
  let closed = false;
  const close = f.reader.closeAndWait();
  close.then(
    () => {
      closed = true;
    },
    () => {
      closed = true;
    },
  );
  const joined = assert.rejects(close, (error) => error === reason);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.equal(f.archives.length, 0);
  f.parent.abort(reason);
  await read;
  await joined;
  await f.disconnected.promise;
  assert.equal(closed, true);
  assert(f.archives.length >= 1);
});

test("Health resumes cleanup without replacing its business failure", async () => {
  assert.equal(typeof implementation.withHealthStateReader, "function");
  const business = new Error("business"),
    cleanup = new Error("archive");
  let joined = false;
  await assert.rejects(
    implementation.withHealthStateReader(
      {
        closeAndWait: async () => {
          joined = true;
          throw cleanup;
        },
      },
      async () => {
        throw business;
      },
    ),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === business &&
      error.errors[1] === cleanup,
  );
  assert(joined);
});
