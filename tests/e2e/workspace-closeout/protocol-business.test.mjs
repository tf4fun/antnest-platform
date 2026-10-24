import assert from "node:assert/strict";
import test from "node:test";
import { workspaceProtocolBusiness } from "./protocol-business.mjs";
import { workspaceBusinessFixture } from "./protocol-business.fixture.mjs";

test("original revocation HTTP response is archived as plain data before Delete", async () => {
  const f = workspaceBusinessFixture(),
    api = f.input.api;
  let response;
  f.input.api = async (...args) => (response = await api(...args));
  await workspaceProtocolBusiness(f.input, f.work);
  assert(response.headers instanceof Headers);
  assert.deepEqual(f.state.business.revocation.request, {
    path: "/api/admin/directory/users/owner/active",
    body: { active: false },
  });
  assert.deepEqual(f.state.business.revocation.response, {
    status: response.status,
    body: response.body,
    headers: Object.fromEntries(response.headers),
    traceID: response.traceID,
  });
  assert.equal(f.state.deleted, true);
  assert.equal(f.events.filter(([kind]) => kind === "api").length, 1);
  assert.equal(f.state.lifecycle.length, 4);
});

test("Workspace retains original physical, audit and revocation proof without new business operations", async () => {
  const f = workspaceBusinessFixture();
  await workspaceProtocolBusiness(f.input, f.work);
  const proof = f.state.business;
  assert.deepEqual(Object.keys(proof), [
    "cancel",
    "offline",
    "rebuilt",
    "revocation",
    "deleted",
  ]);
  assert.equal(proof.cancel.pid, "41");
  assert.equal(proof.cancel.pgid, 41);
  assert.equal(proof.cancel.effects, "started\n");
  assert.equal(proof.cancel.recovered_effects, "started\n");
  assert.equal(proof.cancel.process_after, "");
  assert.deepEqual(proof.cancel.audit, proof.cancel.recovery_audit);
  assert.deepEqual(proof.cancel.recovery_before, proof.cancel.recovery_after);
  assert.equal(proof.offline.effects, "started\nfinished\n");
  assert.equal(proof.offline.rebuilt_effects, proof.offline.effects);
  assert.equal(proof.offline.replay_answer, "c4-offline completed");
  assert.deepEqual(proof.offline.model_before, proof.offline.model_after);
  assert.deepEqual(proof.offline.audit, proof.offline.replay_audit);
  assert.equal(proof.rebuilt.answer, "c4-rebuilt completed");
  assert.equal(proof.rebuilt.audit_page.items.length, 3);
  assert.deepEqual(proof.revocation.model_before, proof.revocation.model_after);
  assert.deepEqual(proof.revocation.audit_before, proof.revocation.audit_after);
  assert.equal(proof.revocation.disabled_agent.activation_state, "disabled");
  assert.equal(proof.revocation.network.attachment.state, "closed");
  assert.deepEqual(proof.deleted.resources, { containers: [], volumes: [] });
  assert.equal(f.state.offboarding.settlementOutcome, "settled");
  assert.equal(
    f.state.offboarding.ownerRevocation.event.event_type,
    "agent_owner_revoked",
  );
  assert.equal(
    f.state.offboarding.disabledEvent.operation_request_id,
    "automatic-disable-request",
  );
  assert.equal(f.requests.length, 16);
  assert.equal(f.state.lifecycle.length, 4);
});

test("the actual Workspace business keeps sixteen wire RPCs and a separate no-wire revocation probe", async () => {
  const f = workspaceBusinessFixture();
  const result = await workspaceProtocolBusiness(f.input, f.work);
  assert.equal(f.clients.length, 5);
  assert.equal(f.requests.length, 16);
  assert.equal(f.observations.length, 11);
  assert.deepEqual(
    f.clients.map((client) => client.requests.map((row) => row.method)),
    [
      ["initialize", "session/new", "session/new", "session/prompt"],
      ["initialize", "session/load", "session/prompt", "session/prompt"],
      ["initialize", "session/load", "session/prompt"],
      ["initialize", "session/load"],
      ["initialize", "session/load", "session/prompt"],
    ],
  );
  assert.deepEqual(
    f.state.lifecycle.map((row) => row.kind),
    ["create", "rebuild", "rebuild", "delete"],
  );
  assert.equal(
    f.state.lifecycle[1].expectation.settlementOutcome,
    "runtime_barrier_required",
  );
  assert.deepEqual(f.state.lifecycle[3].expectation, {
    settlementOutcome: "runtime_barrier_required",
    networkAlreadyClosed: true,
  });
  assert.equal(f.state.providers.length, 5);
  assert.equal(f.state.runs.length, 3);
  assert.deepEqual(
    f.state.runs.map((row) => row.state),
    ["unresolved", "completed", "completed"],
  );
  assert.equal(f.state.deniedConnections.length, 1);
  assert.equal(f.state.probeRejected, true);
  const probe = f.state.business.revocation.closed_connection_probe;
  assert.equal(probe.close.localClose, false);
  assert(probe.close.at >= probe.started_at);
  assert(probe.close.at <= probe.deadline_at);
  assert.equal(probe.cleanup_joined, true);
  assert.equal(probe.post_close_request_sent, false);
  assert.equal(probe.request_count_before, 3);
  assert.equal(probe.request_count_after, 3);
  assert.equal(probe.raw_frame_count_before, probe.raw_frame_count_after);
  const remote = f.events.findIndex(([kind]) => kind === "remote-client-close");
  const joined = f.events.findIndex(
    ([kind, index]) => kind === "client-close" && index === 5,
  );
  assert(
    remote >= 0 && joined > remote,
    "remote closure must precede local cleanup",
  );
  assert.equal(f.watches[0].closure.kind, "local-close");
  assert.equal(f.watches[1].closure.kind, "transport-end");
  assert.equal(f.state.offboarding.requestID, "automatic-disable-request");
  for (const key of [
    "cross_connection_cancel",
    "unknown_run_immutable",
    "contention_rejected",
    "replay_without_effects",
    "rebuild_observed",
    "revocation_observed",
    "deleted_before_teardown",
  ])
    assert.equal(result[key], true);
  assert.equal((await Promise.all(f.state.held)).length, 3);
});

test("original business rejects a cancelled Run from another execution revision", async () => {
  const f = workspaceBusinessFixture(),
    json = f.input.json;
  f.input.json = async (path) => {
    const value = await json(path);
    if (path === "/api/admin/execution-audits/run-cancel")
      value.execution_snapshot.executionRevision = "wrong";
    return value;
  };
  await assert.rejects(workspaceProtocolBusiness(f.input, f.work));
  assert.equal(f.state.lifecycle.length, 1);
});

test("fresh history replay cannot invoke another Provider request", async () => {
  const f = workspaceBusinessFixture(),
    open = f.work.open;
  f.work.open = async (...args) => {
    const client = await open(...args),
      request = client.request;
    if (f.clients.length === 4)
      client.request = async (...call) => {
        const value = await request(...call);
        f.state.providers.push({ phase: "unexpected-replay", stage: "tool" });
        return value;
      };
    return client;
  };
  await assert.rejects(
    workspaceProtocolBusiness(f.input, f.work),
    /replay invoked model\/Tools/u,
  );
  assert.equal(f.state.lifecycle.length, 2);
});

test("revoked admission must not add an execution audit", async () => {
  const f = workspaceBusinessFixture(),
    json = f.input.json;
  f.input.json = async (path) => {
    const value = await json(path);
    if (
      f.state.revoked &&
      path === "/api/admin/execution-audits?agent_id=agent&limit=100"
    )
      value.items.push({
        run_id: "unexpected",
        session_id: "S2",
        agent_id: "agent",
      });
    return value;
  };
  await assert.rejects(workspaceProtocolBusiness(f.input, f.work));
  assert.equal(f.state.deleted, false);
});

for (const phase of ["busy", "barrier"])
  test(`${phase} rejection validation retains the original Error and archive failures`, async () => {
    const f = workspaceBusinessFixture(),
      open = f.work.open;
    const transport = new Error("original wrong rejection"),
      archive = new Error("original request archive failure");
    const original = new AggregateError(
      [transport, archive],
      "original request failed",
    );
    f.work.open = async (...args) => {
      const client = await open(...args),
        request = client.request;
      client.request = (...call) => {
        const target =
          phase === "busy"
            ? f.clients.length === 2 && !f.state.cancelled
            : f.clients.length === 2 && f.state.cancelled;
        return call[0] === "prompt" && target
          ? Promise.reject(original)
          : request(...call);
      };
      return client;
    };
    await assert.rejects(
      workspaceProtocolBusiness(f.input, f.work),
      (error) => {
        assert(error instanceof AggregateError);
        assert(error.errors.includes(original));
        assert(error.errors.some((item) => item !== original));
        return true;
      },
    );
  });

for (const mode of ["local", "before-trigger", "late", "missing"])
  test(`revocation rejects ${mode} old-connection closure evidence`, async () => {
    const f = workspaceBusinessFixture(),
      open = f.work.open;
    f.work.open = async (...args) => {
      const client = await open(...args),
        wait = client.waitForClose;
      if (client.index === 5)
        client.waitForClose = async (...call) => {
          if (mode === "missing")
            throw new Error("original remote close is missing");
          const receipt = await wait(...call);
          if (mode === "local") receipt.localClose = true;
          else
            receipt.at =
              f.state.revocationBegin.observedAt +
              (mode === "before-trigger" ? -1 : 30_001);
          return receipt;
        };
      return client;
    };
    await assert.rejects(workspaceProtocolBusiness(f.input, f.work));
    assert.equal(f.state.deleted, false);
    assert.equal(f.state.deniedConnections.length, 0);
  });

for (const wire of ["request", "frame"])
  test(`a post-close probe must not add a wire ${wire}`, async () => {
    const f = workspaceBusinessFixture(),
      open = f.work.open;
    f.work.open = async (...args) => {
      const client = await open(...args),
        request = client.request,
        snapshot = client.snapshot;
      let extraFrame = false;
      if (client.index === 5) {
        client.snapshot = () => {
          const value = snapshot();
          if (extraFrame)
            value.raw_frames.push({ id: "unexpected", result: {} });
          return value;
        };
        client.request = async (...call) => {
          try {
            return await request(...call);
          } finally {
            if (f.state.revoked) {
              if (wire === "request")
                client.requests.push({
                  requestId: "unexpected",
                  method: "session/prompt",
                });
              else extraFrame = true;
            }
          }
        };
      }
      return client;
    };
    await assert.rejects(workspaceProtocolBusiness(f.input, f.work));
    assert.equal(f.state.deleted, false);
  });

test("revocation joins the original old-connection cleanup before its probes", async () => {
  const f = workspaceBusinessFixture(),
    open = f.work.open;
  const entered = Promise.withResolvers(),
    cleanup = Promise.withResolvers();
  f.work.open = async (...args) => {
    const client = await open(...args),
      close = client.closeAndWait;
    if (client.index === 5)
      client.closeAndWait = async () => {
        const result = await close();
        entered.resolve();
        await cleanup.promise;
        return result;
      };
    return client;
  };
  const business = workspaceProtocolBusiness(f.input, f.work);
  try {
    await Promise.race([
      entered.promise,
      business.then(() => {
        throw new Error(
          "business completed before original cleanup was joined",
        );
      }),
    ]);
    assert.equal(f.state.probeRejected, false);
    assert.equal(f.state.deniedConnections.length, 0);
    assert.equal(f.state.deleted, false);
    cleanup.resolve();
    await business;
  } finally {
    cleanup.resolve();
    await business;
  }
});

test("revocation keeps an original old-connection cleanup failure", async () => {
  const f = workspaceBusinessFixture(),
    open = f.work.open;
  const sentinel = new Error("original old-connection cleanup failed");
  f.work.open = async (...args) => {
    const client = await open(...args),
      close = client.closeAndWait;
    if (client.index === 5)
      client.closeAndWait = async () => {
        await close();
        if (f.state.revoked) throw sentinel;
      };
    return client;
  };
  await assert.rejects(
    workspaceProtocolBusiness(f.input, f.work),
    (error) => error === sentinel,
  );
  assert.equal(f.state.deleted, false);
  assert.equal(f.state.deniedConnections.length, 0);
});
