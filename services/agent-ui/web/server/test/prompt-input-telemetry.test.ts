import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import { setImmediate as turn } from "node:timers/promises";
import { test } from "node:test";
import * as observation from "../src/telemetry.ts";
import { validateJsonRequest } from "../src/http/json-request.ts";
import { createCommandHandler } from "../src/http/command-routes.ts";
import { HistoryTokens } from "../src/bridge/history-token.ts";
import { OperationCoordinator, OperationConflictError, type PreparedPrompt } from "../src/bridge/operations.ts";
import { createTestWorkspaceHttpServer, testHeaders } from "./support/auth-fixture.ts";

const phaseNames = ["receive-started", "body-eof", "body-parsed", "input-prepared"];
const eventName = "antnest.ui.prompt_input";
const clockKey = "antnest.ui.http.started_monotonic_ns";
const parent = "1234567890abcdef";
const scope = { organizationId: "org-1", principalId: "user-1", agentId: "agent-1" };
const condition = { ...scope, sessionId: "session-1", epoch: "epoch-1", incarnation: "one", appendVersion: 0 };
const tokens = new HistoryTokens(Buffer.alloc(32, 9));
const path = "/api/app/workspace/v1/agents/agent-1/sessions/session-1";
const privateBody = "PRIVATE-UPLOAD-CONTENT-CANARY";
const privateHeader = "PRIVATE-UPLOAD-HEADER-CANARY";
const fields = (attributes: any[] = []) => Object.fromEntries(attributes.map(({ key, value }) =>
  [key, value.stringValue ?? (value.intValue === undefined ? value.doubleValue : Number(value.intValue))]));
const close = async (server: Server) => {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
};
const listen = async (server: Server) => {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

test("native Prompt input phases remain exact, private and request-owned through failure and cancellation", { timeout: 20_000 }, async t => {
  const batches: any[] = [], observed: Promise<number>[] = [];
  const inputChannel = channel("antnest.ui.prompt_input.v1");
  const notices: { value: any; received: bigint }[] = [];
  const subscriberErrors: unknown[] = [];
  let replayEof: (() => void) | undefined;
  // Subscriber callbacks must not throw: node:diagnostics_channel reports
  // subscriber exceptions as uncaught exceptions, outside publish's caller.
  const receive = (value: unknown) => {
    try {
      notices.push({ value, received: process.hrtime.bigint() });
      if ((value as { phase: string }).phase === "body-eof") replayEof?.();
    } catch (error) { subscriberErrors.push(error); }
  };
  const synchronousCounts: number[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.url === "/v1/traces") batches.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const endpoint = new URL(await listen(collector));
  const telemetry = await observation.startBridgeTelemetry({ disabled: false, endpoint, serviceName: "agent-ui-input-test" });
  // This instance must not add input diagnostics even with the recording provider above.
  const disabled = await observation.startBridgeTelemetry({ disabled: true, serviceName: "agent-ui-input-disabled-test" });
  let promptLimit = 16 * 1024 * 1024;
  const coordinator = new OperationCoordinator({ async prompt() {}, async readIntent() { return { kind: "unknown" }; },
    async cancel() {}, retainWork() { return () => {}; } });
  const preparedIntents = new WeakMap<PreparedPrompt, string>();
  const handler = createCommandHandler({ tokens, get maxAcpPromptBytes() { return promptLimit; }, async authorize(requestScope) {
    assert.deepEqual(requestScope, scope);
    return { condition, release() {}, operations: {
      async prepare(input, signal) {
        const prepared = await coordinator.prepare(input, signal); preparedIntents.set(prepared, input.intentId); return prepared;
      },
      submitPrepared(prepared) {
        if (preparedIntents.get(prepared) === "conflict") throw new OperationConflictError("fixture conflict");
        return coordinator.submitPrepared(prepared); },
      async read() { throw new Error("unexpected read"); },
      async cancel(_session, intentId, runId) {
        return { operationId: intentId, sessionId: condition.sessionId, phase: "cancelling" as const,
          acceptance: "acp" as const, runId, outputWatermark: 0 };
      },
    } };
  } });
  const options = (owner: typeof telemetry) => ({ requestDeadlineMs: 150, telemetry: {
    observeHttp(...args: Parameters<typeof telemetry.observeHttp>) {
      const pending = owner.observeHttp(...args); observed.push(pending); return pending;
    },
  } });
  const server = createTestWorkspaceHttpServer({ handle: handler }, options(telemetry));
  const offServer = createTestWorkspaceHttpServer({ handle: handler }, options(disabled));
  const origin = await listen(server), offOrigin = await listen(offServer);
  let next = 0;
  type Case = { id: string; name: string; before: bigint; after: bigint; expected: string[]; bytes?: number; firstBytes?: number; disabled?: boolean; unsubscribed?: boolean };
  const cases: Case[] = [];
  const begin = (name: string, expected: string[], bytes?: number, isDisabled = false) => {
    const result: Case = { name, id: (++next).toString(16).padStart(32, "0"), before: process.hrtime.bigint(),
      after: 0n, expected, bytes, disabled: isDisabled };
    cases.push(result); return result;
  };
  const headers = (id: string, intent = "intent", extra: Record<string, string> = {}) =>
    testHeaders({ "x-antnest-organization-id": scope.organizationId,
      "x-antnest-principal-id": scope.principalId, "x-antnest-agent-id": scope.agentId,
      "content-type": "application/json", "if-match": tokens.issue(condition), "idempotency-key": intent,
      traceparent: `00-${id}-${parent}-01`, "x-input-diagnostic": privateHeader, ...extra });
  const valid = (intent: string, length = 2 * 1024 * 1024) => JSON.stringify({
    intentId: intent, expectedAppendVersion: 0, prompt: [{ type: "text", text: privateBody + "x".repeat(length) }],
  });
  const post = async (name: string, body: string | Uint8Array, status: number, expected: string[],
    options: { intent?: string; action?: string; extra?: Record<string, string>; disabled?: boolean } = {}) => {
    const bytes = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
    const item = begin(name, expected, bytes, options.disabled);
    const response = await fetch((options.disabled ? offOrigin : origin) + path + (options.action ?? "/prompts"), {
      method: "POST", headers: headers(item.id, options.intent, options.extra), body,
    });
    await response.text(); item.after = process.hrtime.bigint();
    assert.equal(response.status, status, name);
  };
  const partial = async (name: string, declared: number, prefix: string, status: number, expected: string[]) => {
    const item = begin(name, expected);
    const result = Promise.withResolvers<number>();
    const client = httpRequest(origin + path + "/prompts", {
      method: "POST", headers: headers(item.id, "intent", { "content-length": String(declared) }),
    }, async response => {
      try { for await (const _chunk of response) { /* join the actual response */ } result.resolve(response.statusCode!); }
      catch (cause) { result.reject(cause); }
    });
    const closed = new Promise<void>(resolve => client.once("close", resolve));
    client.on("error", result.reject);
    client.setTimeout(2000, () => client.destroy(new Error("phase fixture response timeout")));
    try {
      client.write(prefix);
      assert.equal(await result.promise, status, name);
      item.after = process.hrtime.bigint();
    } finally { client.destroy(); await closed; }
  };
  inputChannel.subscribe(receive);
  try {
    // Complete both uploads concurrently with distinct incoming traces and byte counts.
    await Promise.all([
      post("first large upload", valid("first"), 202, phaseNames, { intent: "first" }),
      post("second large upload", valid("second", 1024 * 1024), 202, phaseNames, { intent: "second" }),
    ]);
    await post("invalid UTF-8", new Uint8Array([0xff]), 400, phaseNames.slice(0, 2));
    await post("decoded duplicate key", '{"a":1,"\\u0061":2}', 400, phaseNames.slice(0, 2));
    await post("empty body", "", 400, []);
    await post("route schema failure", '{"a":1}', 422, phaseNames.slice(0, 3));
    await post("intent conflict during preparation", valid("conflict", 20), 409, phaseNames.slice(0, 3),
      { intent: "conflict" });
    const wireBody = valid("wire-boundary", 20);
    promptLimit = Buffer.byteLength(wireBody) + 1;
    try {
      await post("wire-size failure during preparation", wireBody, 413, phaseNames.slice(0, 3),
        { intent: "wire-boundary" });
    } finally { promptLimit = 16 * 1024 * 1024; }
    await post("stale history", valid("stale", 20), 409, phaseNames.slice(0, 3),
      { intent: "stale", extra: { "if-match": "invalid-history" } });
    await post("control bypass", '{"expectedRunId":"run-1"}', 200, [], { action: "/operations/held/cancel" });
    await post("unverified request", valid("refused", 20), 401, [],
      { intent: "refused", extra: { "Antnest-Caller-Context": "invalid-context" } });
    await post("disabled with recording provider", valid("disabled", 20), 202, [],
      { intent: "disabled", disabled: true });
    inputChannel.unsubscribe(receive);
    try {
      await post("no local subscriber", valid("unsubscribed", 20), 202, phaseNames,
        { intent: "unsubscribed" });
      cases.at(-1)!.unsubscribed = true;
    } finally { inputChannel.subscribe(receive); }
    await partial("declared oversize", 64 * 1024 * 1024 + 1, "{", 413, []);
    await partial("deadline before EOF", 8192, '{"partial":', 504, phaseNames.slice(0, 1));

    const overread = begin("actual chunked read exceeds the byte budget", phaseNames.slice(0, 1));
    overread.firstBytes = 5;
    await telemetry.observeHttp("POST", "/fixture/prompt", async () => {
      const observer = (observation as any).capturePromptInput?.();
      const request = new Request("http://input.test/prompts", { method: "POST",
        body: new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(Buffer.from('{"x":'));
          controller.enqueue(Buffer.from('12345}'));
          controller.close();
        } }), duplex: "half",
      } as RequestInit & { duplex: "half" });
      await assert.rejects((validateJsonRequest as any)(request, 8, observer),
        (error: any) => error.status === 413 && error.code === "request_too_large");
      return 413;
    }, { traceparent: `00-${overread.id}-${parent}-01` });
    overread.after = process.hrtime.bigint();

    const cancelled = begin("disconnect after EOF", phaseNames.slice(0, 2), Buffer.byteLength(valid("abort")));
    cancelled.firstBytes = cancelled.bytes;
    const abort = new AbortController(), reason = new Error("original input disconnect");
    await telemetry.observeHttp("POST", "/fixture/prompt", async () => {
      const observer = (observation as any).capturePromptInput?.();
      const bytes = Buffer.from(valid("abort"));
      const request = new Request("http://input.test/prompts", { method: "POST", signal: abort.signal,
        body: new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new Uint8Array()); controller.enqueue(bytes); controller.close();
        } }), duplex: "half",
      } as RequestInit & { duplex: "half" });
      const pending = (validateJsonRequest as any)(request, 64 * 1024 * 1024, observer);
      void pending.catch(() => {});
      await turn(); abort.abort(reason);
      await assert.rejects(pending, (error: unknown) => error === reason);
      return 499;
    }, { traceparent: `00-${cancelled.id}-${parent}-01` });
    cancelled.after = process.hrtime.bigint();

    const retired = begin("ended HTTP before EOF", ["receive-started"], 1);
    let retiredObserver: observation.PromptInputObserver | undefined;
    await telemetry.observeHttp("POST", "/fixture/prompt", async () => {
      retiredObserver = observation.capturePromptInput();
      retiredObserver?.("receive-started", 1);
      return 499;
    }, { traceparent: `00-${retired.id}-${parent}-01` });
    retired.after = process.hrtime.bigint();
    retiredObserver?.("body-eof", 1);
    const fresh = begin("old observer cannot borrow a new HTTP boundary", phaseNames, 2);
    await telemetry.observeHttp("POST", "/fixture/prompt", async () => {
      retiredObserver?.("body-eof", 1);
      const observer = observation.capturePromptInput();
      observer?.("receive-started", 2); observer?.("body-eof", 2);
      observer?.("body-parsed", 2); observation.recordPromptInputPrepared();
      return 202;
    }, { traceparent: `00-${fresh.id}-${parent}-01` });
    fresh.after = process.hrtime.bigint();

    const bounded = begin("bounded phases and ended boundary", phaseNames, 42);
    bounded.firstBytes = 8;
    let late: undefined | ((stage: string, bytes: number) => void);
    await telemetry.observeHttp("POST", "/fixture/prompt", async () => {
      late = (observation as any).capturePromptInput?.();
      const count = () => synchronousCounts.push(notices.filter(({ value }) => value.traceId === bounded.id).length);
      late?.("body-eof", 42); late?.("receive-started", 0); count();
      late?.("receive-started", 8); count();
      late?.("receive-started", 9); late?.("body-eof", 7); count();
      replayEof = () => { replayEof = undefined; late?.("body-eof", 42); };
      const foreign = begin("live observer retains source in another active HTTP context", []);
      await telemetry.observeHttp("GET", "/fixture/another", async () => {
        late?.("body-eof", 42); count();
        return 200;
      }, { traceparent: `00-${foreign.id}-${parent}-01` });
      foreign.after = process.hrtime.bigint();
      late?.("body-parsed", 43); count();
      late?.("body-parsed", 42); count();
      (observation as any).recordPromptInputPrepared?.();
      count(); (observation as any).recordPromptInputPrepared?.(); count();
      return 202;
    }, { traceparent: `00-${bounded.id}-${parent}-01` });
    late?.("receive-started", 1); late?.("body-eof", 1); late?.("body-parsed", 1);
    (observation as any).recordPromptInputPrepared?.();
    bounded.after = process.hrtime.bigint();
  } finally {
    try {
      await close(server); await close(offServer);
      await Promise.all(observed);
      await disabled.shutdown(); await telemetry.shutdown(); await close(collector);
    } finally { inputChannel.unsubscribe(receive); }
  }
  const spans = batches.flatMap(batch => batch.resourceSpans.flatMap((resource: any) =>
    resource.scopeSpans.flatMap((scope: any) => scope.spans)));
  for (const item of cases) await t.test(item.name, () => {
    const selected = spans.filter(span => span.traceId === item.id);
    assert.equal(selected.length, 1);
    const span = selected[0];
    assert.equal(span.parentSpanId, parent);
    const events = (span.events ?? []).filter((event: any) => event.name === eventName);
    assert.deepEqual(events.map((event: any) => fields(event.attributes).phase), item.expected);
    const local = notices.filter(({ value }) => value.traceId === item.id);
    assert.deepEqual(local.map(({ value }) => value.phase), item.unsubscribed ? [] : item.expected.slice(0, 2));
    for (const [index, notice] of local.entries()) {
      const value = notice.value, event = fields(events[index].attributes);
      assert(Object.isFrozen(value) && Object.isFrozen(value.processIdentity));
      assert.deepEqual(Object.keys(value).sort(),
        ["bytes", "monotonic_ns", "phase", "processIdentity", "spanId", "traceId"]);
      assert.equal(value.spanId, span.spanId);
      assert.equal(value.monotonic_ns, event.monotonic_ns, "local and OTLP must share the original sample");
      assert.equal(value.bytes, event.bytes);
      assert(BigInt(value.monotonic_ns) <= notice.received && notice.received <= item.after);
      const resource = batches.flatMap(batch => batch.resourceSpans).find((candidate: any) =>
        candidate.scopeSpans.some((scope: any) => scope.spans.includes(span)));
      const identity = fields(resource.resource.attributes);
      assert.deepEqual(value.processIdentity, Object.fromEntries(
        ["host.name", "process.pid", "service.instance.id"].map(key => [key, identity[key]])));
    }
    const start = fields(span.attributes)[clockKey];
    if (item.disabled) assert.equal(start, undefined);
    else {
      assert.match(start ?? "", /^[1-9][0-9]{0,29}$/u);
      assert(item.before <= BigInt(start) && BigInt(start) <= item.after);
    }
    let previous = BigInt(start ?? "0"), firstBytes = 0;
    for (const event of events) {
      const value = fields(event.attributes);
      assert.deepEqual(Object.keys(value).sort(), ["bytes", "monotonic_ns", "phase"]);
      assert.match(value.monotonic_ns, /^[1-9][0-9]{0,29}$/u);
      const at = BigInt(value.monotonic_ns);
      assert(previous <= at && at <= item.after); previous = at;
      assert(BigInt(span.startTimeUnixNano) <= BigInt(event.timeUnixNano));
      assert(BigInt(event.timeUnixNano) <= BigInt(span.endTimeUnixNano));
      assert(Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= 64 * 1024 * 1024);
      if (value.phase === "receive-started") {
        firstBytes = value.bytes;
        if (item.firstBytes !== undefined) assert.equal(firstBytes, item.firstBytes);
      }
      else { assert(value.bytes >= firstBytes); assert.equal(value.bytes, item.bytes); }
    }
  });
  await t.test("local phase notifications are synchronous, ordered and exactly once", () => {
    assert.deepEqual(subscriberErrors, []);
    assert.equal(replayEof, undefined);
    assert.deepEqual(synchronousCounts, [0, 1, 1, 2, 2, 2, 2, 2]);
    assert.equal(notices.length, cases.filter(item => !item.unsubscribed)
      .reduce((sum, item) => sum + Math.min(item.expected.length, 2), 0));
  });
  await t.test("no input values, credentials or identities enter the new evidence", () => {
    const raw = JSON.stringify([batches, notices.map(notice => notice.value)]);
    assert(!raw.includes(privateBody)); assert(!raw.includes(privateHeader));
    for (const span of spans) for (const event of span.events ?? [])
      if (event.name === eventName)
        for (const value of Object.values(scope)) assert(!JSON.stringify(event).includes(value));
  });
});
