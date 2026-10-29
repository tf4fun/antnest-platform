import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { member, setup } from "./c4-setup.mjs";

test("C4 state reads retain the original member session, Principal and complete configuration", async (t) => {
  const principal = { organization_id: "organization", user_id: "member" };
  const accessToken = "C4-ORIGINAL-MEMBER-SESSION";
  const wire = [],
    pending = new Set(),
    errors = [];
  const server = createServer((request, response) => {
    const task = (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString();
      const body = text ? JSON.parse(text) : undefined;
      wire.push({ path: request.url, body, cookie: request.headers.cookie });
      let value = {},
        status = 200;
      if (request.url === "/api/session/login") {
        const isMember = body.email === member.email;
        value = {
          principal: isMember ? principal : { ...principal, user_id: "admin" },
        };
        response.setHeader("set-cookie", [
          `antnest_session=${isMember ? accessToken : "ADMIN-SESSION"}; Path=/`,
          "antnest_csrf=ORIGINAL-CSRF; Path=/",
        ]);
      } else if (request.url === "/api/admin/directory/users") {
        value = { user: { id: principal.user_id } };
      } else if (request.url === "/api/admin/provider-connections") {
        status = 201;
      } else if (request.url === "/api/admin/model-profiles") {
        value = { items: [{ model_profile_id: "profile" }] };
      } else if (request.url === "/api/admin/templates") {
        status = 201;
        value = { template_id: "template", revision: "revision" };
      } else if (request.url === "/api/admin/agents") {
        status = 202;
        value = {
          agent: { agent_id: "original-agent" },
          operation: { request_id: "operation" },
        };
      } else if (request.url === "/api/admin/operations/operation") {
        value = { state: "completed" };
      } else if (request.url === "/api/admin/agents/original-agent") {
        value = {
          lifecycle_state: "created",
          activation_state: "enabled",
          desired_state: "enabled",
          runtime_state: "available",
          readiness: "ready",
          executable_execution_revision: "execution",
          runtime: { runtime_revision: "runtime" },
        };
      } else if (request.url === "/api/admin/directory/users/member/active") {
        response.setHeader("x-antnest-trace-id", "a".repeat(32));
        value = { status: "updated" };
      } else {
        status = 404;
      }
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(value));
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      (error) => {
        errors.push(error);
        pending.delete(task);
        response.destroy();
      },
    );
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await Promise.allSettled([...pending]);
    if (errors.length) throw new AggregateError(errors);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const config = { gateway: `http://127.0.0.1:${server.address().port}` };
  const signal = AbortSignal.timeout(5000),
    reads = [];
  const state = {
    agent_id: "original-agent",
    access_allowed: true,
    configuration_revision: "a".repeat(64),
    availability: "ready",
    active_session_id: null,
    unavailable_reason: null,
  };
  const failure = new Error("private state unavailable");
  const fixture = await setup(config, signal, {
    stateReader: async (options) => {
      reads.push(options);
      if (reads.length === 2) throw failure;
      return state;
    },
  });
  assert.equal(await fixture.state(), state);
  await assert.rejects(fixture.state(), (error) => error === failure);
  assert.equal(reads.length, 2);
  for (const read of reads) {
    assert.equal(read.config, config);
    assert.equal(read.signal, signal);
    assert.equal(read.agentId, state.agent_id);
    assert.equal(read.browser.accessToken, accessToken);
    assert.deepEqual(read.principal, principal);
  }
  assert.equal(
    wire.filter(
      (row) =>
        row.path === "/api/session/login" && row.body.email === member.email,
    ).length,
    1,
  );
  assert(!wire.some((row) => row.path.includes("/api/app/")));
  // Without a tokenizer ACP budgets one token per UTF-8 byte, so the default
  // window must hold Runtime tool schemas and guidance with margin.
  const [provider] = wire.filter(
    (row) => row.path === "/api/admin/provider-connections",
  );
  assert.equal(provider.body.models[0].model.context_window, 65536);
  assert.equal(provider.body.models[0].model.tokenizer, undefined);
  assert.deepEqual(fixture.adminPrincipal, { ...principal, user_id: "admin" });
  const changed = await fixture.request(
    "/api/admin/directory/users/member/active",
    { body: { active: false } },
  );
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body, { status: "updated" });
  assert.equal(changed.traceID, "a".repeat(32));
  assert(Number.isFinite(Date.parse(changed.headers.get("date"))));
  assert.equal(
    wire.at(-1).cookie,
    "antnest_session=ADMIN-SESSION; antnest_csrf=ORIGINAL-CSRF",
  );
  assert.deepEqual(wire.at(-1).body, { active: false });
});
