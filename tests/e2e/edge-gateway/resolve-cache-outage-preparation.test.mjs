import assert from "node:assert/strict";
import test from "node:test";
import { prepareOutageAdmissions } from "./resolve-cache-outage-preparation.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

function fixture() {
  let time = 1000;
  const events = [],
    requests = [],
    origins = new Map(),
    controller = new AbortController(),
    factoryEntered = deferred(),
    factoryRelease = deferred(),
    freshnessEntered = deferred(),
    freshnessRelease = deferred();
  const owner = {
    user_id: "owner",
    organization_id: "organization",
    membership_id: "owner-membership",
    organization_role: "member",
    active: true,
  };
  const admin = {
    ...owner,
    user_id: "administrator",
    membership_id: "admin-membership",
    organization_role: "admin",
  };
  const controls = {
    holdFactory: false,
    holdFreshness: false,
    freshError: null,
    staleFinalACK: false,
    staleACKs: 2,
    mutateLogin() {},
  };
  const runtime = {
    evidence: { observations: [] },
    async assertFresh() {
      events.push("freshness-start");
      freshnessEntered.resolve();
      if (controls.holdFreshness) await freshnessRelease.promise;
      controller.signal.throwIfAborted();
      if (controls.freshError) throw controls.freshError;
      time += 137;
      events.push("freshness-complete");
    },
  };
  const options = {
    evidence: {
      consumer_restarts: [
        {
          service: "agent-acp-service",
          after: { started_at: "2026-10-15T00:00:00Z" },
        },
      ],
    },
    agentID: "agent",
    ownerCredentials: { email: "owner@example.invalid" },
    adminCredentials: { email: "admin@example.invalid" },
    prepPrincipal: owner,
    prepClient: { cookie: "private-prep-owner-cookie" },
    signal: controller.signal,
    docker: () => assert.fail("unexpected Docker"),
    config: { project: "owned-project" },
    async login(credentials, label) {
      controller.signal.throwIfAborted();
      events.push(label);
      time += 5;
      const result = {
        client: { cookie: `private-${label}-cookie`, label },
        response: {
          body: {
            principal: structuredClone(
              credentials === options.ownerCredentials ? owner : admin,
            ),
          },
        },
      };
      controls.mutateLogin(result, label);
      return result;
    },
    async http(client, path, { label, requestSignal = controller.signal }) {
      requestSignal.throwIfAborted();
      const profile = path.startsWith("/api/admin/") ? "console" : "workspace";
      const key = `${client.cookie}:${profile}`;
      if (!origins.has(key)) origins.set(key, time);
      const row = { client, path, label, started_at: time };
      requests.push(row);
      time += 5;
      row.at = time;
      if (path === "/api/admin/execution-synchronization") {
        const stale =
          controls.staleACKs-- > 0 ||
          (controls.staleFinalACK &&
            label === "fresh-configuration-acknowledgement");
        row.body = {
          synchronization: {
            revision: 2,
            applied_revision: stale ? 1 : 2,
            applied_at: "2026-10-15T00:00:01Z",
          },
        };
      } else if (path === "/api/admin/agents/agent") {
        row.body = { agent_id: "agent", owner_user_id: "owner" };
      } else {
        assert.equal(path, "/api/app/workspace/v1/agents/agent/view");
        row.body = {
          agentId: "agent",
          availability: "ready",
          activeSessionId: null,
        };
      }
      return row;
    },
    async poll(check, _label, signal, timeout) {
      assert.equal(signal, controller.signal);
      assert.equal(timeout, 10000);
      for (let attempts = 0; attempts < 5; attempts++) {
        signal.throwIfAborted();
        const value = await check(signal);
        if (value) return value;
        time += 1250;
      }
      throw new Error("ACK fixture timeout");
    },
    async createRuntimeWork(value) {
      events.push("factory-start");
      options.createdWith = value;
      factoryEntered.resolve();
      if (controls.holdFactory) await factoryRelease.promise;
      controller.signal.throwIfAborted();
      time += 1000;
      events.push("factory-complete");
      return runtime;
    },
  };
  return {
    options,
    controls,
    events,
    requests,
    origins,
    controller,
    runtime,
    factoryEntered,
    factoryRelease,
    freshnessEntered,
    freshnessRelease,
    time: () => time,
    finalRequests: () =>
      requests.filter((r) =>
        ["warm-login", "audit-login"].includes(r.client.label),
      ),
  };
}

for (const stage of ["Factory", "Freshness"]) {
  test(`final credentials remain unused while Runtime ${stage} is pending`, async () => {
    const f = fixture();
    f.controls[`hold${stage}`] = true;
    const running = prepareOutageAdmissions(f.options);
    void running.catch(() => {});
    try {
      await Promise.race([f[`${stage.toLowerCase()}Entered`].promise, running]);
      assert.deepEqual(f.finalRequests(), []);
      assert(!f.events.includes("warm-login"));
      assert(!f.events.includes("audit-login"));
      f[`${stage.toLowerCase()}Release`].resolve();
      await running;
    } finally {
      f.controller.abort();
      f.factoryRelease.resolve();
      f.freshnessRelease.resolve();
      await running.catch(() => {});
    }
  });
}

test("slow preparation leaves the original final Resolve budgets intact", async () => {
  const f = fixture();
  const result = await prepareOutageAdmissions(f.options);
  const restart = f.time() + 8000;
  for (const [client, profile] of [
    [result.client, "workspace"],
    [result.administrator, "console"],
  ]) {
    assert(
      restart < f.origins.get(`${client.cookie}:${profile}`) + 10000,
      "preparation consumed original authority budget",
    );
  }
  assert.equal(
    f.requests.filter((r) => r.label === "fresh-configuration-acknowledgement")
      .length,
    1,
  );
  assert.equal(
    f.requests.filter((r) => r.label === "prep-configuration-acknowledgement")
      .length,
    3,
  );
  assert.deepEqual(
    f.finalRequests().map((r) => r.label),
    ["fresh-configuration-acknowledgement", "fresh-consumer-agent-ready"],
  );
});

test("Runtime preparation uses the independent member and administrator Principals", async () => {
  const f = fixture();
  const result = await prepareOutageAdmissions(f.options);
  assert.equal(f.options.createdWith.principal, f.options.prepPrincipal);
  assert.notEqual(
    f.options.createdWith.readerPrincipal,
    result.adminSession.body.principal,
  );
  assert.deepEqual(
    f.options.createdWith.readerPrincipal,
    result.adminSession.body.principal,
  );
  assert.equal(
    f.requests.find((r) => r.path === "/api/admin/agents/agent").client.label,
    "prep-admin-login",
  );
  assert.equal(result.runtimeWork, f.runtime);
  assert.equal(f.options.evidence.runtime, f.runtime.evidence);
  assert.equal(result.session.body, f.options.evidence.session_deadlines.owner);
});

test("failed freshness never admits a final protected request", async () => {
  const f = fixture();
  const failure = new Error("Runtime contains previous work");
  f.controls.freshError = failure;
  await assert.rejects(
    prepareOutageAdmissions(f.options),
    (e) => e === failure,
  );
  assert.deepEqual(f.finalRequests(), []);
});

test("a final stale ACK fails without polling or admitting the workspace", async () => {
  const f = fixture();
  f.controls.staleFinalACK = true;
  await assert.rejects(
    prepareOutageAdmissions(f.options),
    /configuration acknowledgement/u,
  );
  assert.deepEqual(
    f.finalRequests().map((r) => r.label),
    ["fresh-configuration-acknowledgement"],
  );
});

for (const label of ["warm-login", "audit-login"]) {
  for (const field of ["organization_id", "user_id", "membership_id"]) {
    test(`changed ${label} ${field} cannot reuse preparation`, async () => {
      const f = fixture();
      f.controls.mutateLogin = (row, current) => {
        if (current === label) row.response.body.principal[field] = "foreign";
      };
      await assert.rejects(
        prepareOutageAdmissions(f.options),
        /preparation Principal/u,
      );
      assert.deepEqual(f.finalRequests(), []);
    });
  }
  test(`reused ${label} Cookie cannot turn preparation into a warm admission`, async () => {
    const f = fixture();
    f.controls.mutateLogin = (row, current) => {
      if (current === label)
        row.client.cookie =
          label === "warm-login"
            ? f.options.prepClient.cookie
            : "private-prep-admin-login-cookie";
    };
    await assert.rejects(
      prepareOutageAdmissions(f.options),
      /preparation Cookie/u,
    );
    assert.deepEqual(f.finalRequests(), []);
  });
}
