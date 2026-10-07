import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
export const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const methods = ["apply-execution-snapshot", "settle-agent"];
const id = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const revision = (value) => Number.isSafeInteger(value) && value > 0;
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
async function bytes(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const b of stream) {
    size += b.length;
    assert(size <= limit, "fixture body too large");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
export function startProxy(
  upstream,
  port = 8080,
  host = "0.0.0.0",
  { holdMs = 60000 } = {},
) {
  const origin = new URL(upstream).origin;
  let selection,
    armed = false,
    held;
  const records = [];
  function matches(method, input) {
    return (
      selection?.method === method &&
      input.organization_id === selection.organization_id &&
      (method === "settle-agent"
        ? input.agent_id === selection.agent_id
        : input.revision === selection.revision)
    );
  }
  function receipt(method, input, output, headers) {
    if (
      !matches(method, input) ||
      !output ||
      typeof output !== "object" ||
      Array.isArray(output) ||
      !revision(output.applied_revision)
    )
      return;
    if (
      method === "apply-execution-snapshot"
        ? output.organization_id !== input.organization_id ||
          output.applied_revision < input.revision
        : !id(input.operation_id) ||
          !revision(input.minimum_revision) ||
          output.applied_revision < input.minimum_revision ||
          !["settled", "runtime_barrier_required", "not_settled"].includes(
            output.outcome,
          )
    )
      return;
    assert(records.length < 512);
    const result = {
      receipt_id: randomUUID(),
      method,
      organization_id: input.organization_id,
      ...(method === "settle-agent"
        ? {
            agent_id: input.agent_id,
            operation_id: input.operation_id,
            minimum_revision: input.minimum_revision,
            mode: input.mode,
            deadline_at: input.deadline_at,
            outcome: output.outcome,
          }
        : { revision: input.revision }),
      applied_revision: output.applied_revision,
      request_hash: hash(input),
      response_hash: hash(output),
      traceparent: headers.traceparent,
      status: 200,
      delivery: "pending",
    };
    records.push(result);
    return result;
  }
  return createServer(async (req, res) => {
    const abort = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      if (req.method === "GET" && req.url === "/status")
        return json(res, 200, { status: "ok" });
      if (req.method === "GET" && req.url === "/__test/status")
        return json(res, 200, {
          selection,
          armed,
          held: held?.record ?? null,
          records,
        });
      if (req.method !== "POST")
        return json(res, 405, { code: "method_not_allowed" });
      const body = await bytes(req, 16 * 1024 * 1024),
        input = JSON.parse(body);
      if (req.url === "/__test/arm") {
        if (held || armed) return json(res, 409, { code: "fault_pending" });
        if (
          !methods.includes(input.method) ||
          !id(input.organization_id) ||
          (input.method === "settle-agent"
            ? !id(input.agent_id)
            : !revision(input.revision))
        )
          return json(res, 400, { code: "invalid_selection" });
        selection = {
          method: input.method,
          organization_id: input.organization_id,
          ...(input.method === "settle-agent"
            ? { agent_id: input.agent_id }
            : { revision: input.revision }),
        };
        records.length = 0;
        armed = true;
        return json(res, 200, { armed: true });
      }
      if (req.url === "/__test/drop") {
        if (
          !held ||
          held.response.destroyed ||
          held.record.receipt_id !== input.receipt_id
        )
          return json(res, 409, { code: "no_matching_response" });
        held.record.delivery = "dropped";
        held.response.destroy();
        held = undefined;
        return json(res, 200, { dropped: true });
      }
      const method = req.url?.replace("/rpc/agent-acp/", "");
      if (!methods.includes(method) || req.url !== `/rpc/agent-acp/${method}`)
        return json(res, 404, { code: "not_found" });
      const headers = { "content-type": "application/json" };
      for (const name of [
        "traceparent",
        "tracestate",
        "antnest-service-authorization",
      ])
        if (req.headers[name]) headers[name] = req.headers[name];
      const response = await fetch(origin + req.url, {
        method: "POST",
        body,
        headers,
        redirect: "error",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
      });
      const result = await bytes(response.body, 1024 * 1024);
      let record;
      if (response.status === 200) {
        let output;
        try {
          output = JSON.parse(result);
        } catch {
          /* Forward invalid upstream output unchanged. */
        }
        record = receipt(method, input, output, req.headers);
      }
      if (record && armed) {
        armed = false;
        record.delivery = "held";
        held = { record, response: res };
        const timer = setTimeout(() => {
          record.delivery = "expired";
          res.destroy();
        }, holdMs);
        res.once("close", () => {
          clearTimeout(timer);
          if (record.delivery === "held") record.delivery = "lost_before_drop";
          if (held?.response === res) held = undefined;
        });
        return;
      }
      res.writeHead(response.status, {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
      });
      res.end(result, () => {
        if (record) record.delivery = "delivered";
      });
    } catch {
      if (!res.destroyed && !res.headersSent)
        json(res, 502, { code: "fixture_proxy_failure" });
      else res.destroy();
    }
  }).listen(port, host);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  startProxy("http://agent-acp-control:8081");
