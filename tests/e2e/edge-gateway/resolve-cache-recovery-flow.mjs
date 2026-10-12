import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GatewayClient } from "../identity-closeout/support.mjs";
import { connectOwner } from "../lifecycle-closeout/acp.mjs";
import { observedHeldRun } from "../workspace-closeout/browser-control.mjs";
import { observeWorkspaceStream } from "./resolve-cache-stream.mjs";
import { joinRecoveryRun } from "./resolve-cache-recovery-cleanup.mjs";
import {
  inspectRecoveryWindow,
  recoveryCases,
  recoveryMembershipUpdate,
} from "./resolve-cache-recovery.mjs";

const mark = () => ({ at: performance.now(), observed_at_ms: Date.now() });
const freezeClient = (client) => {
  const frozen = new GatewayClient(client.base);
  frozen.cookies = new Map(client.cookies);
  return frozen;
};

export async function verifyRecovery({
  config,
  fixture,
  credentials,
  administrator,
  signal,
  evidence,
  secrets,
  http,
  login,
  model,
  poll,
  credentialScope,
}) {
  evidence.recovery = { cases: [] };
  let current = { ...credentials };
  const directory = await http(administrator, "/api/admin/directory", {
    label: "recovery-directory",
  });
  const entry = directory.body.users.find(
    ({ user }) => user.id === fixture.ownerID,
  );
  assert(
    entry?.membership &&
      entry.membership.role === "member" &&
      entry.membership.active,
  );
  evidence.recovery.directory = directory;
  const membership = entry.membership;
  const mutationPath = `/api/admin/directory/memberships/${encodeURIComponent(membership.id)}`;
  const update = (active) => recoveryMembershipUpdate(entry, active);
  for (const { name, phase } of recoveryCases) {
    console.log(JSON.stringify({ phase: "recovery", check: name }));
    const c = { name, phase };
    evidence.recovery.cases.push(c);
    const { client, response: signedIn } = await login(
      current,
      `recovery-${name}-login`,
    );
    c.login = signedIn;
    const { client: peer, response: peerLogin } = await login(
      current,
      `recovery-${name}-peer-login`,
    );
    c.peer_login = peerLogin;
    const frozen = freezeClient(client);
    const owner = connectOwner(
      config.gateway,
      fixture.agentID,
      client.cookie,
      signal,
      { captureWire: true, injectTraceParent: false },
    );
    owner.wire.credential_scope = credentialScope(client.cookie);
    c.wire = owner.wire;
    let stream, closeWork, failure;
    const saveStream = () => {
      if (stream)
        c.stream = {
          ...stream.evidence,
          records: stream.records,
          closure: stream.closure,
          revoked: stream.revoked,
        };
    };
    try {
      await owner.initialize({
        "antnest.dev/bridge": {
          intentReceipt: 1,
          targetCancel: 1,
          deliveryMark: 1,
        },
      });
      c.session_id = (
        await owner.request("new", { cwd: "/workspace", mcpServers: [] })
      ).sessionId;
      assert(c.session_id);
      const base = `/api/app/workspace/v1/agents/${encodeURIComponent(fixture.agentID)}`;
      const path = `${base}/sessions/${encodeURIComponent(c.session_id)}`;
      const view = await http(client, `${path}/view`, {
        label: `recovery-${name}-initial-view`,
      });
      c.initial_view = view;
      stream = await observeWorkspaceStream(
        client,
        fixture.agentID,
        c.session_id,
        signal,
        { credentialScope },
      );
      saveStream();
      await stream.wait((v) => v.selectedView?.sessionId === c.session_id);
      c.intent_id = randomUUID();
      c.prompt = await http(client, `${path}/prompts`, {
        label: `recovery-${name}-prompt`,
        status: 202,
        headers: {
          "If-Match": view.body.historyToken,
          "Idempotency-Key": c.intent_id,
        },
        body: {
          intentId: c.intent_id,
          expectedAppendVersion: view.body.appendVersion,
          prompt: [{ type: "text", text: phase }],
        },
      });
      const accepted = await stream.wait((v) =>
        v.operations.some(
          (op) =>
            op.operationId === c.intent_id &&
            op.acceptance === "acp" &&
            op.runId &&
            ["accepted", "running"].includes(op.phase),
        ),
      );
      c.run_id = observedHeldRun(
        accepted.view,
        fixture.agentID,
        c.session_id,
      ).runId;
      c.model_started = await poll(async () => {
        const value = await model();
        return value.state.pending.includes(phase) && value;
      }, `${name} model held`);
      const auditPath = `/api/admin/execution-audits/${encodeURIComponent(c.run_id)}`;
      c.audit_before = await http(administrator, auditPath, {
        label: `recovery-${name}-running-audit`,
      });
      assert.equal(c.audit_before.body.state, "running");
      stream.assertOpen();
      assert.equal(owner.closeCode, undefined);
      c.quiet_requests = c.wire.frames
        .filter((f) => f.direction === "send")
        .map((f) => f.raw);
      c.trigger = mark();
      if (name === "logout") {
        c.mutation = await http(client, "/api/session", {
          method: "DELETE",
          status: 204,
          label: "recovery-logout-mutation",
        });
        assert(client.cookie === "", "logout did not clear cookies");
      } else if (name === "password") {
        const nextPassword = "c4-recovery-password";
        secrets.push(nextPassword);
        const oldCookie = client.cookie,
          oldCSRF = client.csrf;
        c.mutation = await http(client, "/api/session/password", {
          body: {
            current_password: current.password,
            new_password: nextPassword,
          },
          label: "recovery-password-mutation",
        });
        assert(
          client.cookie !== oldCookie && client.csrf !== oldCSRF,
          "password did not rotate Cookie and CSRF",
        );
        c.mutation.issued_credential_scope = credentialScope(client.cookie);
        current = { ...current, password: nextPassword };
      } else
        c.mutation = await http(administrator, mutationPath, {
          body: update(name !== "deactivate"),
          label: `recovery-${name}-mutation`,
        });
      // Both waits are observed and joined even when one fails. No local close
      // runs until their remote outcomes (or bounded failures) have settled.
      closeWork = Promise.allSettled([
        owner
          .waitForClose(Math.max(1, c.trigger.at + 30000 - performance.now()))
          .then((event) => {
            c.wss_close = { ...event, observed_at: performance.now() };
            return c.wss_close;
          }),
        stream.waitClosed(
          Math.max(1, c.trigger.at + 30000 - performance.now()),
        ),
      ]);
      const closures = await closeWork;
      const failures = closures
        .filter((r) => r.status === "rejected")
        .map((r) => r.reason);
      if (failures.length)
        throw new AggregateError(failures, `${name} remote retirement failed`);
      saveStream();
      c.old_session = await http(frozen, "/api/session", {
        status: 401,
        label: `recovery-${name}-old-session`,
      });
      c.peer_session = await http(peer, "/api/session", {
        status: name === "logout" ? 200 : 401,
        label: `recovery-${name}-peer-session`,
      });
      if (name === "password")
        c.old_password = await http(
          new GatewayClient(config.gateway),
          "/api/session/login",
          { body: credentials, status: 401, label: "recovery-old-password" },
        );
      if (name === "deactivate") {
        c.deactivated_login = await http(
          new GatewayClient(config.gateway),
          "/api/session/login",
          { body: current, status: 401, label: "recovery-inactive-login" },
        );
        c.model_terminal = await poll(
          async () => {
            const value = await model();
            return (
              value.state.requests.some(
                (r) => r.phase === phase && r.disconnected === true,
              ) && value
            );
          },
          "offboarding model cancelled",
          signal,
          30000,
        );
        c.audit_terminal = await poll(
          async () => {
            const row = await http(administrator, auditPath, {
              label: "recovery-deactivate-terminal-audit",
            });
            return (
              row.body.state === "cancelled" &&
              row.body.executor_state === "quiescent" &&
              row
            );
          },
          "offboarding settled Run",
          signal,
          30000,
        );
        c.disabled_agent = await poll(
          async () => {
            const row = await http(
              administrator,
              `/api/admin/agents/${encodeURIComponent(fixture.agentID)}`,
              { label: "recovery-disabled-agent" },
            );
            return (
              row.body.desired_state === "disabled" &&
              row.body.activation_state === "disabled" &&
              row.body.runtime_state === "absent" &&
              row
            );
          },
          "offboarding disabled Agent",
          signal,
          30000,
        );
        c.restore = await http(administrator, mutationPath, {
          body: update(true),
          label: "recovery-restore-membership",
        });
        const fresh = await login(current, "recovery-reactivated-login");
        c.fresh_login = fresh.response;
        c.restored_state = await http(
          fresh.client,
          `/api/app/agents/${encodeURIComponent(fixture.agentID)}/state`,
          { label: "recovery-reactivated-agent-state" },
        );
        c.restored_old_session = await http(frozen, "/api/session", {
          status: 401,
          label: "recovery-restored-old-session",
        });
      } else {
        c.model_after_close = await model();
        c.audit_after_close = await http(administrator, auditPath, {
          label: `recovery-${name}-after-close-audit`,
        });
        assert.equal(c.audit_after_close.body.state, "running");
        const fresh = await login(current, `recovery-${name}-fresh-login`);
        c.fresh_login = fresh.response;
        const started_at = performance.now();
        const release = await fetch(`${config.model}/release/${phase}`, {
          method: "POST",
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        await release.arrayBuffer();
        c.release = { started_at, ...mark(), status: release.status };
        assert.equal(release.status, 200);
        c.audit_terminal = await poll(async () => {
          const row = await http(administrator, auditPath, {
            label: `recovery-${name}-terminal-audit`,
          });
          return (
            row.body.state === "completed" &&
            row.body.executor_state === "quiescent" &&
            row
          );
        }, `${name} accepted Run completed`);
        c.model_terminal = await model();
        c.fresh_view = await poll(async () => {
          const row = await http(fresh.client, `${path}/view`, {
            label: `recovery-${name}-fresh-view`,
          });
          return (
            row.body.turns.some(
              (t) => t.turnId === c.run_id && t.outcome === "completed",
            ) && row
          );
        }, `${name} fresh viewer same completed Run`);
      }
    } catch (error) {
      failure = error;
      c.failure = { message: error.message };
      throw error;
    } finally {
      if (closeWork) await closeWork;
      const errors = [];
      if (failure && c.run_id && c.prompt)
        try {
          await joinRecoveryRun({
            c,
            signal,
            model,
            release: async (requestSignal) => {
              const started_at = performance.now();
              const response = await fetch(`${config.model}/release/${phase}`, {
                method: "POST",
                signal: requestSignal,
              });
              await response.arrayBuffer();
              return { started_at, ...mark(), status: response.status };
            },
            audit: (requestSignal) =>
              http(
                administrator,
                `/api/admin/execution-audits/${encodeURIComponent(c.run_id)}`,
                {
                  requestSignal,
                  label: `recovery-${name}-failure-cleanup-audit`,
                },
              ),
          });
        } catch (error) {
          errors.push(error);
        }
      if (stream)
        try {
          await stream.closeAndWait();
        } catch (error) {
          errors.push(error);
        }
      try {
        await owner.closeAndWait();
      } catch (error) {
        errors.push(error);
      }
      saveStream();
      if (errors.length)
        c.cleanup_errors = errors.map((error) => error.message);
      if (errors.length && !failure)
        throw new AggregateError(errors, "recovery observer cleanup failed");
    }
  }
  return inspectRecoveryWindow(evidence);
}
