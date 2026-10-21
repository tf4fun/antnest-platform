import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspect } from "node:util";

const path = "/rpc/identity/resolve-access-token";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function fail(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(unique, "Workspace authority and archive failed");
}
function decode(receipt) {
  const raw = Buffer.from(receipt.raw_body_base64, "base64");
  assert.equal(raw.toString("base64"), receipt.raw_body_base64);
  assert.equal(raw.length, receipt.body_bytes);
  assert(
    raw.length > 0 && raw.length <= 65536,
    "invalid Identity response size",
  );
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new Error("invalid Workspace Identity response JSON");
  }
}

// One scope belongs to one attempted connection, state read or watch. The
// service supplies the same real workload grant and original Session to Identity;
// this observer neither creates a login nor issues a caller context itself.
export function createWorkspaceAuthority({
  service: base,
  identityEndpoint,
  agentId,
  browser,
  principal: original,
  signal,
  secrets,
  telemetry,
  preserve,
}) {
  assert.equal(typeof preserve, "function");
  assert.equal(typeof telemetry?.startHTTP, "function");
  assert(Array.isArray(secrets));
  const target = new URL(identityEndpoint);
  assert(
    ["http:", "https:"].includes(target.protocol) &&
      target.pathname === "/" &&
      !target.search &&
      !target.hash &&
      !target.username &&
      !target.password,
    "plain Identity origin required",
  );
  assert(typeof agentId === "string" && agentId);
  const token = browser.accessToken,
    principal = structuredClone(original);
  assert(typeof token === "string" && token);
  for (const key of ["organization_id", "user_id"])
    assert(typeof principal?.[key] === "string" && principal[key]);
  secrets.push(token);
  const rows = [],
    resourceErrors = [];
  let attempted = false,
    operation,
    closing,
    activeParent;
  const snapshot = () => structuredClone(rows);
  const service = Object.create(base);
  async function archive() {
    try {
      await preserve(snapshot());
    } catch (error) {
      resourceErrors.push(error);
      throw error;
    }
  }
  service.workspaceContext = async (
    accessToken,
    requestedAgent,
    options = {},
  ) => {
    assert(
      !closing && !attempted,
      "Workspace authority scope was already used",
    );
    assert(accessToken === token, "foreign Workspace login");
    assert.equal(requestedAgent, agentId, "foreign Workspace Agent");
    const signals = [signal, options.signal].filter(Boolean);
    const parent = signals.length ? AbortSignal.any(signals) : undefined;
    parent?.throwIfAborted();
    activeParent = parent;
    attempted = true;
    const row = {
      agentId,
      principal: structuredClone(principal),
      session_digest: hash(token),
      method: "POST",
      path,
      request_body: { profile: "workspace", agent_id: agentId },
      request_started_at: Date.now(),
      body_outcome: "failed",
      client_ended: false,
      errors: [],
    };
    rows.push(row);
    operation = (async () => {
      const errors = [];
      let issued, rejection, client;
      try {
        client = telemetry.startHTTP("POST", "identity-service");
        row.traceID = client.traceID;
        row.clientSpanID = client.clientSpanID;
        assert.match(row.traceID, /^[a-f0-9]{32}$/u);
        assert.match(row.clientSpanID, /^[a-f0-9]{16}$/u);
        assert.equal(
          client.traceparent,
          `00-${row.traceID}-${row.clientSpanID}-01`,
        );
        const response = await base.send(
          target.origin + path,
          "gateway-identity",
          {
            body: {
              access_token: token,
              profile: "workspace",
              agent_id: agentId,
            },
            signal: parent,
            headers: { traceparent: client.traceparent },
          },
        );
        row.status = response.status;
        row.response_received_at = Date.now();
        row.response_trace_id = response.headers.get("x-antnest-trace-id");
        row.server_date = response.headers.get("date");
        row.content_type = response.headers.get("content-type");
        const raw = Buffer.from(await response.arrayBuffer());
        row.response_completed_at = Date.now();
        row.body_bytes = raw.length;
        row.raw_body_base64 = raw.toString("base64");
        row.body_outcome = "eof";
        parent?.throwIfAborted();
        if (row.response_trace_id !== null)
          assert(
            row.response_trace_id === row.traceID,
            "Identity response Trace differs from the actual CLIENT",
          );
        if (response.status === 200) {
          const value = decode(row);
          assert(
            typeof value?.caller_context === "string" &&
              value.caller_context.length > 0 &&
              value.caller_context.length <= 8192,
            "Identity workspace context missing",
          );
          for (const key of ["organization_id", "user_id"])
            assert(
              value.principal?.[key] === principal[key],
              "Identity workspace authority changed",
            );
          issued = {
            context: value.caller_context,
            principal: value.principal,
          };
          secrets.push(issued.context);
        } else {
          // Keep status/body/Trace in private evidence; the thrown message
          // deliberately contains neither credentials nor response contents.
          rejection = new Error("Workspace Identity Resolve rejected");
        }
      } catch (error) {
        errors.push(error);
        resourceErrors.push(error);
        row.errors.push(inspect(error, { depth: 8 }));
      }
      if (client)
        try {
          client.end(
            row.status,
            errors.length ? "failed" : "eof",
            row.body_bytes ?? 0,
            row.body_outcome,
          );
          row.client_ended = true;
        } catch (error) {
          errors.push(error);
          resourceErrors.push(error);
          row.errors.push(inspect(error, { depth: 8 }));
        }
      try {
        await archive();
      } catch (error) {
        errors.push(error);
      }
      if (parent?.aborted) {
        errors.push(parent.reason);
        resourceErrors.push(parent.reason);
      }
      if (rejection) errors.unshift(rejection);
      fail(errors);
      return issued;
    })();
    void operation.catch(() => {});
    return operation;
  };
  return {
    service,
    snapshot,
    closeAndWait() {
      if (!closing) {
        closing = Promise.resolve().then(async () => {
          if (operation) await Promise.allSettled([operation]);
          try {
            await archive();
          } catch {}
          if (signal?.aborted) resourceErrors.push(signal.reason);
          if (activeParent?.aborted) resourceErrors.push(activeParent.reason);
          fail(resourceErrors);
          return snapshot();
        });
        void closing.catch(() => {});
      }
      return closing;
    },
  };
}

export function assertWorkspaceResolveDenied(
  receipt,
  expected,
  { requireTrace = true } = {},
) {
  assert(receipt, "actual Workspace Resolve receipt required");
  assert.equal(receipt.agentId, expected.agentID);
  assert.deepEqual(receipt.principal, expected.principal);
  assert.match(receipt.session_digest, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.session_digest, expected.session_digest);
  assert.equal(receipt.method, "POST");
  assert.equal(receipt.path, path);
  assert.deepEqual(receipt.request_body, {
    profile: "workspace",
    agent_id: expected.agentID,
  });
  assert.equal(
    receipt.status,
    401,
    "owner revocation requires original Identity 401",
  );
  if (requireTrace) {
    assert.match(receipt.traceID, /^[a-f0-9]{32}$/u);
    assert.match(receipt.clientSpanID, /^[a-f0-9]{16}$/u);
  }
  if (requireTrace && receipt.response_trace_id !== null)
    assert(
      receipt.response_trace_id === receipt.traceID,
      "Identity response Trace differs from the actual CLIENT",
    );
  assert.equal(receipt.body_outcome, "eof");
  assert.equal(receipt.client_ended, true);
  assert(/^application\/json(?:\s*;|$)/iu.test(receipt.content_type));
  assert.deepEqual(receipt.errors, []);
  assert(
    [
      receipt.request_started_at,
      receipt.response_received_at,
      receipt.response_completed_at,
      expected.after,
    ].every(Number.isSafeInteger),
  );
  assert(
    expected.after >= 0 &&
      receipt.request_started_at >= expected.after &&
      receipt.response_received_at >= receipt.request_started_at &&
      receipt.response_completed_at >= receipt.response_received_at,
    "Workspace Resolve denial outside original revocation sequence",
  );
  const body = decode(receipt),
    denial = {
      code: "unauthenticated",
      message: "Authentication failed",
      retryable: false,
    };
  assert(
    body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.keys(body).length === Object.keys(denial).length &&
      Object.entries(denial).every(([key, value]) => body[key] === value),
    "Workspace Identity response is not the original unauthenticated denial",
  );
  return receipt;
}
