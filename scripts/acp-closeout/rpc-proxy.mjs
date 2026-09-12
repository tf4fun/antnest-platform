import assert from "node:assert/strict";
import { createServer } from "node:http";
import { hash, snapshotHash } from "./rpc-snapshot.mjs";

const prefix = "/rpc/agent-controller/";
const methods = new Set(["acquire-run", "finish-run"]);
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    assert(size <= 1024 * 1024);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}
const reply = (response, code, body) => {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const identity = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

export function startProxy(upstream, port = 8080, host = "0.0.0.0") {
  let selection;
  let armed = false;
  let held;
  const records = [];
  const admissions = new Map();
  const matches = (scope) =>
    selection &&
    scope?.agent_id === selection.agent_id &&
    scope?.session_id === selection.session_id;
  function control(path, body, response) {
    if (path === "/__test/arm") {
      if (held || armed) return reply(response, 409, { code: "fault_pending" });
      if (
        !methods.has(body.method) ||
        !identity(body.agent_id) ||
        !identity(body.session_id)
      )
        return reply(response, 400, { code: "invalid_selection" });
      selection = {
        method: body.method,
        agent_id: body.agent_id,
        session_id: body.session_id,
      };
      records.length = 0;
      armed = true;
      return reply(response, 200, { armed: true });
    }
    if (path === "/__test/drop") {
      if (
        !held ||
        held.response.destroyed ||
        held.response.writableEnded ||
        held.record.request_id !== body.request_id
      )
        return reply(response, 409, { code: "no_matching_response" });
      held.record.delivery = "dropped";
      held.response.destroy();
      held = undefined;
      return reply(response, 200, { dropped: true });
    }
    return reply(response, 404, { code: "not_found" });
  }
  function record(method, input, output, headers) {
    if (method === "acquire-run" && identity(output.admission_id))
      admissions.set(output.admission_id, {
        agent_id: input.agent_id,
        session_id: input.session_id,
      });
    const scope =
      method === "acquire-run" ? input : admissions.get(input.admission_id);
    if (!matches(scope)) return undefined;
    const { request_id: _requestID, ...semantic } = input;
    const result = {
      method,
      agent_id: scope.agent_id,
      session_id: scope.session_id,
      request_id: input.request_id,
      admission_id:
        method === "acquire-run" ? output.admission_id : input.admission_id,
      execution_revision: output.execution_revision,
      terminal_class: input.terminal_class,
      tool_effect_state: input.tool_effect_state,
      stop_reason: input.stop_reason,
      unknown_effect_source: input.unknown_effect_source,
      error_class: input.error_class,
      finish_status: method === "finish-run" ? output.status : undefined,
      admission_state: output.admission_state,
      semantic_hash: hash(method === "finish-run" ? semantic : input),
      response_hash: hash(output),
      snapshot_hash:
        method === "acquire-run" ? snapshotHash(output) : undefined,
      traceparent: headers.traceparent,
      status: 200,
      delivery: "pending",
    };
    records.push(result);
    return result;
  }
  async function forward(request, response, body) {
    assert(request.url.startsWith("/") && !request.url.startsWith("//"));
    const url = new URL(request.url, upstream);
    assert.equal(url.origin, new URL(upstream).origin);
    const headers = {};
    for (const name of ["content-type", "traceparent", "tracestate", "baggage"])
      if (request.headers[name]) headers[name] = request.headers[name];
    const result = await fetch(url, {
      method: request.method,
      headers,
      ...(body ? { body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const bytes = await result.arrayBuffer();
    assert(bytes.byteLength <= 1024 * 1024);
    const method = request.url.startsWith(prefix)
      ? request.url.slice(prefix.length)
      : "";
    let receipt;
    if (
      request.method === "POST" &&
      methods.has(method) &&
      result.status === 200
    )
      receipt = record(
        method,
        JSON.parse(body),
        JSON.parse(Buffer.from(bytes).toString()),
        request.headers,
      );
    if (receipt && armed && method === selection.method) {
      armed = false;
      receipt.delivery = "held";
      held = { record: receipt, response };
      const timer = setTimeout(() => response.destroy(), 20000);
      response.once("close", () => {
        clearTimeout(timer);
        if (receipt.delivery === "held") receipt.delivery = "lost_before_drop";
        if (held?.response === response) held = undefined;
      });
      return;
    }
    response.writeHead(result.status, {
      "content-type":
        result.headers.get("content-type") ?? "application/octet-stream",
    });
    response.end(Buffer.from(bytes), () => {
      if (receipt) receipt.delivery = "delivered";
    });
  }
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/__test/status")
        return reply(response, 200, {
          selection,
          armed,
          held: held?.record ?? null,
          records,
        });
      const body = await readBody(request);
      if (request.url.startsWith("/__test/")) {
        if (request.method !== "POST")
          return reply(response, 405, { code: "method_not_allowed" });
        return control(request.url, JSON.parse(body), response);
      }
      await forward(request, response, body);
    } catch {
      if (!response.headersSent)
        reply(response, 502, { code: "fixture_proxy_failure" });
      else response.destroy();
    }
  }).listen(port, host);
}

if (process.argv[1]?.endsWith("/rpc-proxy.mjs"))
  startProxy("http://agent-controller:8080");
