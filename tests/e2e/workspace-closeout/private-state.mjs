import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { inspect } from "node:util";
import schema from "../../../contracts/agent-acp/agent-execution-state.schema.json" with { type: "json" };
import { PrivateACPExecutionStateUnavailableError } from "../../support/private-acp-execution-state-error.mjs";

const require = createRequire(
  new URL("../../../services/agent-acp-service/package.json", import.meta.url),
);
const { Ajv2020 } = require("ajv/dist/2020.js");
const validateState = new Ajv2020({ strict: false }).compile(schema);
const path = "/rpc/agent-acp/get-agent-execution-state";
const unavailable = {
  code: "execution_state_unavailable",
  message: "Agent execution state is unavailable",
  retryable: true,
};
function fail(errors) {
  const unique = [...new Set(errors)];
  if (unique.length === 1) throw unique[0];
  if (unique.length)
    throw new AggregateError(
      unique,
      "Workspace state, archive or cleanup failed",
    );
}

// Workspace owns the actual HTTP CLIENT and lossless reader receipt. Other
// consumers retain the shared state reader and their own acceptance contracts.
export async function readWorkspacePrivateState(agentId, browser, options) {
  const { service, telemetry, endpoint, signal, secrets, receipts, preserve } =
    options;
  const principal = structuredClone(options.principal),
    accessToken = browser.accessToken;
  signal?.throwIfAborted();
  assert.equal(typeof preserve, "function", "Workspace state archive required");
  assert(Array.isArray(secrets) && Array.isArray(receipts));
  assert(typeof agentId === "string" && agentId);
  assert(typeof accessToken === "string" && accessToken);
  for (const field of ["organization_id", "user_id"])
    assert(
      typeof principal?.[field] === "string" && principal[field],
      "original Workspace Principal required",
    );
  const target = new URL(endpoint);
  assert(
    ["http:", "https:"].includes(target.protocol) &&
      target.pathname === path &&
      !target.username &&
      !target.password &&
      !target.search &&
      !target.hash,
    "invalid Workspace state endpoint",
  );
  secrets.push(accessToken);
  const issued = await service.workspaceContext(accessToken, agentId, {
    signal,
  });
  signal?.throwIfAborted();
  for (const field of ["organization_id", "user_id"])
    assert(
      issued.principal?.[field] === principal[field],
      "Workspace authority changed",
    );
  const headers = service.authorization("agent-ui-acp"),
    grant = headers["Antnest-Service-Authorization"];
  assert(
    typeof grant === "string" && grant.startsWith("Bearer "),
    "Workspace workload grant required",
  );
  secrets.push(issued.context, grant, grant.slice(7));
  const operation = telemetry.startHTTP("POST");
  const errors = [],
    chunks = [];
  const row = {
    agentId,
    principal,
    session_digest: createHash("sha256").update(accessToken).digest("hex"),
    method: "POST",
    path,
    request_body: {},
    traceID: operation.traceID,
    clientSpanID: operation.clientSpanID,
    request_started_at: Date.now(),
    body_bytes: 0,
    body_outcome: "failed",
    raw_body_base64: "",
    joined: false,
    errors: [],
  };
  receipts.push(row);
  const record = () => {
    row.raw_body_base64 = Buffer.concat(chunks).toString("base64");
    row.errors = [...new Set(errors)].map((error) =>
      inspect(error, { depth: 8 }),
    );
  };
  let reader, state;
  try {
    const response = await service.send(target.href, "agent-ui-acp", {
      body: {},
      context: issued.context,
      signal,
      headers: {
        ...headers,
        Accept: "application/json",
        traceparent: operation.traceparent,
      },
    });
    row.status = response.status;
    row.content_type = response.headers.get("content-type");
    row.response_trace_id = response.headers.get("x-antnest-trace-id");
    row.response_received_at = Date.now();
    reader = response.body.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      chunks.push(chunk);
      row.body_bytes += chunk.length;
      assert(
        row.body_bytes <= 1024 * 1024,
        "Workspace state response exceeds its evidence bound",
      );
    }
    row.body_outcome = "eof";
    row.response_completed_at = Date.now();
    signal?.throwIfAborted();
    assert(
      /^application\/json(?:\s*;|$)/iu.test(row.content_type ?? ""),
      "invalid Workspace state content type",
    );
    if (row.response_trace_id != null)
      assert(
        row.response_trace_id === row.traceID,
        "Workspace state response Trace changed",
      );
    try {
      state = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      throw new Error("invalid Workspace state JSON");
    }
    if (row.status !== 200) {
      if (
        row.status === 503 &&
        state &&
        typeof state === "object" &&
        !Array.isArray(state) &&
        Object.keys(state).length === Object.keys(unavailable).length &&
        Object.entries(unavailable).every(
          ([key, value]) => state[key] === value,
        )
      )
        throw new PrivateACPExecutionStateUnavailableError();
      throw new Error("Workspace state HTTP response rejected");
    }
    assert(validateState(state), "invalid complete Workspace state schema");
    assert(state.agent_id === agentId, "foreign Workspace state Agent");
  } catch (error) {
    errors.push(error);
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } catch (error) {
        errors.push(error);
      }
      try {
        reader.releaseLock();
      } catch (error) {
        errors.push(error);
      }
    }
    if (signal?.aborted) errors.push(signal.reason);
    try {
      operation.end(
        row.status,
        signal?.aborted ? "cancelled" : errors.length ? "failed" : "eof",
        row.body_bytes,
        row.body_outcome,
      );
    } catch (error) {
      errors.push(error);
    }
    row.joined = true;
    record();
    try {
      await preserve(structuredClone(row));
    } catch (error) {
      errors.push(error);
    }
    if (signal?.aborted) errors.push(signal.reason);
    record();
  }
  fail(errors);
  return state;
}
