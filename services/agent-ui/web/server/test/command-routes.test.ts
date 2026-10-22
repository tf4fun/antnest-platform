import { TestRequest as Request } from "./support/auth-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { HistoryTokens } from "../src/bridge/history-token.ts";
import { createCommandHandler } from "../src/http/command-routes.ts";
import { ReplayCapacityError } from "../src/bridge/replay-load-gate.ts";
import { SessionNotFoundError } from "../src/adapters/acp-http.ts";
import {
  OperationCoordinator,
  type PreparedPrompt,
  type PromptIntent,
  type RetryTicket,
} from "../src/bridge/operations.ts";

const scope = {
  organizationId: "org-1",
  principalId: "user-1",
  agentId: "agent-1",
};
const condition = {
  ...scope,
  sessionId: "session-1",
  epoch: "epoch-1",
  incarnation: "incarnation-1",
  appendVersion: 3,
};
const tokens = new HistoryTokens(Buffer.alloc(32, 7));
const base =
  "http://localhost/api/app/workspace/v1/agents/agent-1/sessions/session-1";
const prompt = {
  intentId: "intent-1",
  expectedAppendVersion: 3,
  prompt: [{ type: "text", text: "hello" }],
};

type FixtureControl = {
  prompt?(input: PromptIntent): Promise<unknown>;
  readIntent?(): Promise<{ kind: "unknown" }>;
  afterPrepared?(input: PromptIntent, ordinal: number): Promise<void>;
};

function fixture(
  maxAcpPromptBytes?: number,
  afterPreparation?: () => void,
  beforeRetry?: () => Promise<void>,
  control: FixtureControl = {},
) {
  const calls: string[] = [];
  const preparedInputs: PromptIntent[] = [];
  const retryTickets: RetryTicket[] = [];
  const forwardedTickets: Array<RetryTicket | undefined> = [];
  const authorizedCondition = { ...condition };
  const coordinator = new OperationCoordinator({
    async prompt(input) { return control.prompt?.(input); },
    async readIntent() { return control.readIntent?.() ?? { kind: "unknown" }; },
    async cancel() {}, retainWork() { return () => {}; },
  });
  const handler = createCommandHandler({
    tokens,
    ...(maxAcpPromptBytes === undefined ? {} : { maxAcpPromptBytes }),
    async authorize(requestScope, sessionId) {
      calls.push(`authorize:${sessionId}`);
      assert.deepEqual(requestScope, scope);
      return {
        condition: authorizedCondition,
        release() {
          calls.push("release");
        },
        operations: {
          async prepare(input, signal) {
            preparedInputs.push(structuredClone(input));
            const ordinal = preparedInputs.length;
            const prepared = await coordinator.prepare(input, signal);
            afterPreparation?.();
            await control.afterPrepared?.(input, ordinal);
            return prepared;
          },
          submitPrepared(prepared) {
            const accepted = coordinator.submitPrepared(prepared);
            calls.push(`submit:${accepted.operationId}`);
            return accepted;
          },
          beginRetry(sessionId: string, intentId: string) {
            const ticket = coordinator.beginRetry(sessionId, intentId);
            retryTickets.push(ticket);
            return ticket;
          },
          async retryPrepared(prepared: PreparedPrompt, ticket?: RetryTicket) {
            calls.push("retry");
            forwardedTickets.push(ticket);
            await beforeRetry?.();
            return coordinator.retryPrepared(prepared, ticket);
          },
          async read(_sessionId, intentId) {
            calls.push(`read:${intentId}`);
            return {
              operationId: intentId,
              sessionId: "session-1",
              phase: "uncertain" as const,
              acceptance: "unknown" as const,
            };
          },
          async cancel(_sessionId, intentId, runId) {
            calls.push(`cancel:${intentId}:${runId}`);
            return {
              operationId: intentId,
              sessionId: "session-1",
              phase: "cancelling" as const,
              acceptance: "acp" as const,
              runId,
              outputWatermark: 0,
            };
          },
        },
      };
    },
  });
  return {
    handler, calls, coordinator, preparedInputs, authorizedCondition,
    retryTickets, forwardedTickets,
  };
}

function request(
  path: string,
  method = "GET",
  body?: unknown,
  extra?: Record<string, string>,
  signal?: AbortSignal,
): Request {
  return new Request(`${base}${path}`, {
    method,
    signal,
    headers: {
      "x-antnest-organization-id": scope.organizationId,
      "x-antnest-principal-id": scope.principalId,
      "x-antnest-agent-id": scope.agentId,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("missing Session operation read returns permanent absence", async () => {
  const handler = createCommandHandler({ tokens,
    async authorize() { throw new SessionNotFoundError(); },
  });
  const response = await handler(request("/operations/intent-1"));
  assert.equal(response?.status, 404);
  assert.equal((await response?.json()).code, "session_not_found");
});

test("prompt accepts a current history condition and stable idempotency key", async () => {
  const { handler, calls } = fixture();
  const response = await handler(
    request("/prompts", "POST", prompt, {
      "if-match": tokens.issue(condition),
      "idempotency-key": "intent-1",
    }),
  );
  assert.equal(response?.status, 202);
  assert.deepEqual(await response?.json(), {
    operationId: "intent-1",
    acceptance: "bridge",
    phase: "dispatching",
  });
  assert.deepEqual(calls, [
    "authorize:session-1",
    "submit:intent-1",
    "release",
  ]);
});

test("Prompt admission rejects an ACP request above its POST limit before returning 202", async () => {
  const browserBodyBytes = Buffer.byteLength(JSON.stringify(prompt));
  const { handler, calls } = fixture(browserBodyBytes + 1);
  const response = await handler(request("/prompts", "POST", prompt, {
    "if-match": tokens.issue(condition),
    "idempotency-key": "intent-1",
  }));
  assert.equal(response?.status, 413);
  assert.equal((await response?.json()).code, "request_too_large");
  assert.deepEqual(calls, ["authorize:session-1", "release"]);

  const admitted = fixture(1024);
  assert.equal((await admitted.handler(request("/prompts", "POST", prompt, {
    "if-match": tokens.issue(condition),
    "idempotency-key": "intent-1",
  })))?.status, 202);
  assert.ok(admitted.calls.includes("submit:intent-1"));
});

test("stale token, mismatched key and path identity cannot dispatch", async () => {
  const { handler, calls } = fixture();
  for (const headers of [
    {
      "if-match": tokens.issue({ ...condition, appendVersion: 2 }),
      "idempotency-key": "intent-1",
    },
    { "if-match": tokens.issue(condition), "idempotency-key": "other" },
  ])
    assert.notEqual(
      (await handler(request("/prompts", "POST", prompt, headers)))?.status,
      202,
    );
  const foreign = request("/prompts", "POST", prompt, {
    "if-match": tokens.issue(condition),
    "idempotency-key": "intent-1",
    "x-antnest-agent-id": "agent-2",
  });
  assert.equal((await handler(foreign))?.status, 403);
  assert.equal(calls.includes("submit:intent-1"), false);
});

test("operation recovery and targeted cancel reauthorize on every request", async () => {
  const { handler, calls } = fixture();
  const operation = await handler(request("/operations/intent-1"));
  assert.equal(operation?.status, 200);
  assert.equal((await operation?.json()).phase, "uncertain");
  const cancelled = await handler(
    request("/operations/intent-1/cancel", "POST", { expectedRunId: "run-1" }),
  );
  assert.equal(cancelled?.status, 200);
  assert.deepEqual(calls, [
    "authorize:session-1",
    "read:intent-1",
    "release",
    "authorize:session-1",
    "cancel:intent-1:run-1",
    "release",
  ]);
});

test("malformed route segments and missing trusted identity are rejected", async () => {
  const { handler, calls } = fixture();
  assert.equal(
    (await handler(request("/operations/intent%2Fother")))?.status,
    404,
  );
  const untrusted = new Request(`${base}/operations/intent-1`);
  assert.equal((await handler(untrusted))?.status, 401);
  assert.deepEqual(calls, []);
});

test("unsupported and incomplete ACP content blocks cannot reach dispatch", async () => {
  const { handler, calls } = fixture();
  for (const invalid of [
    { type: "future_content" },
    { type: "image", data: "abcd" },
  ]) {
    const response = await handler(
      request(
        "/prompts",
        "POST",
        { ...prompt, prompt: [invalid] },
        {
          "if-match": tokens.issue(condition),
          "idempotency-key": "intent-1",
        },
      ),
    );
    assert.equal(response?.status, 422);
  }
  assert.equal(calls.includes("submit:intent-1"), false);
});

test("oversized declared bodies and invalid UTF-8 fail before dispatch", async () => {
  const { handler, calls } = fixture();
  const headers = {
    "if-match": tokens.issue(condition),
    "idempotency-key": "intent-1",
    "content-length": "67108865",
  };
  assert.equal(
    (await handler(request("/prompts", "POST", prompt, headers)))?.status,
    413,
  );
  const invalid = new Request(`${base}/prompts`, {
    method: "POST",
    headers: {
      "x-antnest-organization-id": scope.organizationId,
      "x-antnest-principal-id": scope.principalId,
      "x-antnest-agent-id": scope.agentId,
      "content-type": "application/json",
      "if-match": tokens.issue(condition),
      "idempotency-key": "intent-1",
    },
    body: new Uint8Array([0xff]),
  });
  assert.equal((await handler(invalid))?.status, 422);
  assert.equal(calls.includes("submit:intent-1"), false);
});

test("prompt admission reports exhausted replay capacity explicitly", async () => {
  const handler = createCommandHandler({
    tokens,
    async authorize() {
      throw new ReplayCapacityError();
    },
  });
  const response = await handler(
    request("/prompts", "POST", prompt, {
      "if-match": tokens.issue(condition),
      "idempotency-key": "intent-1",
    }),
  );
  assert.equal(response?.status, 429);
  assert.equal((await response?.json()).code, "replay_capacity_exceeded");
});

for (const cause of ["disconnect", "deadline"]) {
  test(`a prompt cancelled by ${cause} while awaiting preparation never submits and releases its lease once`, async () => {
    const { handler, calls } = fixture();
    const abort = new AbortController();
    const pending = handler(request("/prompts", "POST", prompt, {
      "if-match": tokens.issue(condition),
      "idempotency-key": "intent-1",
    }, abort.signal));
    try {
      await turn();
      abort.abort(new Error(cause));
      const response = await pending;
      assert.notEqual(response?.status, 202);
      assert.deepEqual(calls, ["authorize:session-1", "release"]);
    } finally { abort.abort(); await pending; }
  });
}

test("a ready cancel bypasses pending prompt preparation while its lease stays held", async () => {
  const { handler, calls } = fixture();
  const pending = handler(request("/prompts", "POST", prompt, {
    "if-match": tokens.issue(condition),
    "idempotency-key": "intent-1",
  }));
  try {
    await turn();
    assert.deepEqual(calls, ["authorize:session-1"]);
    const cancelled = await handler(request("/operations/running/cancel", "POST", { expectedRunId: "run-1" }));
    assert.equal(cancelled?.status, 200);
    assert.deepEqual(calls, ["authorize:session-1", "authorize:session-1", "cancel:running:run-1", "release"]);
    assert.equal((await pending)?.status, 202);
    assert.deepEqual(calls.slice(-2), ["submit:intent-1", "release"]);
  } finally { await pending; }
});

test("disconnect after preparation cannot publish Bridge acceptance or dispatch", async () => {
  const abort = new AbortController();
  const { handler, calls } = fixture(undefined, () => abort.abort(new Error("disconnect after preparation")));
  const response = await handler(request("/prompts", "POST", prompt, {
    "if-match": tokens.issue(condition), "idempotency-key": "intent-1",
  }, abort.signal));
  assert.notEqual(response?.status, 202);
  assert.deepEqual(calls, ["authorize:session-1", "release"]);
});

const promptHeaders = () => ({
  "if-match": tokens.issue(condition),
  "idempotency-key": prompt.intentId,
});
const dispatched = (calls: string[]) =>
  calls.some((call) => call === "retry" || call.startsWith("submit:"));

for (const [query, expectedCall] of [
  ["", "submit:intent-1"],
  ["?", "submit:intent-1"],
  ["?action=retry", "retry"],
  ["?%61ction=%72etry", "retry"],
] as const) {
  test(`Prompt query ${JSON.stringify(query)} selects only its exact action`, async () => {
    const f = fixture();
    try {
      if (expectedCall === "retry") {
        await f.handler(request("/prompts", "POST", prompt, promptHeaders()));
        await f.coordinator.settled("session-1", prompt.intentId);
        f.calls.length = 0;
        f.preparedInputs.length = 0;
      }
      const response = await f.handler(
        request(`/prompts${query}`, "POST", prompt, promptHeaders()),
      );
      assert.equal(response?.status, 202);
      assert.deepEqual(await response?.json(), {
        operationId: prompt.intentId,
        acceptance: "bridge",
        phase: "dispatching",
      });
      assert.deepEqual(f.calls, ["authorize:session-1", expectedCall, "release"]);
      assert.deepEqual(f.preparedInputs, [{ sessionId: "session-1", ...prompt }]);
    } finally {
      await f.coordinator.settled("session-1", prompt.intentId);
    }
  });
}

for (const query of [
  "?action",
  "?action=",
  "?action=submit",
  "?action=Retry",
  "?Action=retry",
  "?action=retry&action=retry",
  "?action=retry&action=submit",
  "?action=submit&action=retry",
  "?%61ction=retry&action=retry",
  "?action=retry&extra=1",
  "?extra=1&action=retry",
  "?extra=1",
  "?=retry",
]) {
  test(`Prompt query ${query} is invalid without falling back to submission`, async () => {
    const f = fixture();
    try {
      const response = await f.handler(
        request(`/prompts${query}`, "POST", prompt, promptHeaders()),
      );
      assert.equal(response?.status, 422);
      assert.equal((await response?.json()).code, "invalid_request");
      assert.equal(dispatched(f.calls), false);
    } finally {
      await f.coordinator.settled("session-1", prompt.intentId);
    }
  });
}

for (const [name, body] of [
  ["extra action", { ...prompt, action: "retry" }],
  ["extra history token", { ...prompt, historyToken: "body-token" }],
  ["missing intent", { expectedAppendVersion: prompt.expectedAppendVersion, prompt: prompt.prompt }],
  ["missing append CAS", { intentId: prompt.intentId, prompt: prompt.prompt }],
  ["missing content", { intentId: prompt.intentId, expectedAppendVersion: prompt.expectedAppendVersion }],
  ["incomplete attachment", { ...prompt, prompt: [{ type: "image", data: "original" }] }],
] as const) {
  test(`explicit retry rejects ${name} under the unchanged three-field Prompt schema`, async () => {
    const f = fixture();
    const response = await f.handler(
      request("/prompts?action=retry", "POST", body, promptHeaders()),
    );
    assert.equal(response?.status, 422);
    assert.equal((await response?.json()).code, "invalid_request");
    assert.equal(dispatched(f.calls), false);
    assert.deepEqual(f.preparedInputs, []);
  });
}

for (const [name, headers, status, code] of [
  ["missing idempotency key", { "if-match": tokens.issue(condition) }, 409, "intent_key_mismatch"],
  ["changed idempotency key", { ...promptHeaders(), "idempotency-key": "other-intent" }, 409, "intent_key_mismatch"],
  ["missing history token", { "idempotency-key": prompt.intentId }, 428, "history_condition_required"],
  ["stale history token", { ...promptHeaders(), "if-match": tokens.issue({ ...condition, appendVersion: 2 }) }, 409, "stale_history"],
  ["another Agent grant", { ...promptHeaders(), "x-antnest-agent-id": "other-agent" }, 403, "access_denied"],
] as const) {
  test(`explicit retry rejects ${name} before preparing or dispatching`, async () => {
    const f = fixture();
    const response = await f.handler(
      request("/prompts?action=retry", "POST", prompt, headers),
    );
    assert.equal(response?.status, status);
    assert.equal((await response?.json()).code, code);
    assert.equal(dispatched(f.calls), false);
    assert.deepEqual(f.preparedInputs, []);
  });
}

test("explicit retry requires trusted identity and reauthorizes its Session", async () => {
  const f = fixture();
  const untrusted = new Request(`${base}/prompts?action=retry`, {
    method: "POST",
    headers: { ...promptHeaders(), "content-type": "application/json" },
    body: JSON.stringify(prompt),
  });
  assert.equal((await f.handler(untrusted))?.status, 401);
  assert.deepEqual(f.calls, []);
  f.authorizedCondition.sessionId = "another-session";
  const forbidden = await f.handler(
    request("/prompts?action=retry", "POST", prompt, promptHeaders()),
  );
  assert.equal(forbidden?.status, 403);
  assert.equal((await forbidden?.json()).code, "access_denied");
  assert.deepEqual(f.calls, ["authorize:session-1", "release"]);
  assert.deepEqual(f.preparedInputs, []);
});

test("explicit retry refreshes only history authority while preserving the original append CAS and full content", async () => {
  const f = fixture();
  try {
    await f.handler(request("/prompts", "POST", prompt, promptHeaders()));
    await f.coordinator.settled("session-1", prompt.intentId);
    f.calls.length = 0;
    f.preparedInputs.length = 0;
    f.authorizedCondition.incarnation = "refreshed-incarnation";
    f.authorizedCondition.appendVersion = 4;
    const response = await f.handler(request("/prompts?action=retry", "POST", prompt, {
      ...promptHeaders(), "if-match": tokens.issue(f.authorizedCondition),
    }));
    assert.equal(response?.status, 202);
    assert.deepEqual(f.preparedInputs, [{ sessionId: "session-1", ...prompt }]);
    assert.equal(f.preparedInputs[0]?.expectedAppendVersion, 3);
    assert.deepEqual(f.calls, ["authorize:session-1", "retry", "release"]);
  } finally {
    await f.coordinator.settled("session-1", prompt.intentId);
  }
});

test("explicit retry retains the encoded ACP request limit before invoking retryPrepared", async () => {
  const bodyBytes = Buffer.byteLength(JSON.stringify(prompt));
  const f = fixture(bodyBytes + 1);
  const response = await f.handler(
    request("/prompts?action=retry", "POST", prompt, promptHeaders()),
  );
  assert.equal(response?.status, 413);
  assert.equal((await response?.json()).code, "request_too_large");
  assert.equal(dispatched(f.calls), false);
  assert.deepEqual(f.calls, ["authorize:session-1", "release"]);
});

test("explicit retry prepares a complete Prompt above the 16 KiB control-body limit", async () => {
  const original = {
    ...prompt,
    prompt: [
      { type: "text", text: "original ".repeat(3_000) },
      { type: "resource", resource: {
        uri: "file:///original.txt", mimeType: "text/plain", text: "Complete original attachment",
      } },
    ],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > 16 * 1024);
  const f = fixture();
  try {
    await f.handler(request("/prompts", "POST", original, promptHeaders()));
    await f.coordinator.settled("session-1", original.intentId);
    f.calls.length = 0;
    f.preparedInputs.length = 0;
    const response = await f.handler(
      request("/prompts?action=retry", "POST", original, promptHeaders()),
    );
    assert.equal(response?.status, 202);
    assert.deepEqual(f.preparedInputs, [{ sessionId: "session-1", ...original }]);
    assert.deepEqual(f.calls, ["authorize:session-1", "retry", "release"]);
  } finally {
    await f.coordinator.settled("session-1", original.intentId);
  }
});

test("a retry query wait does not occupy the global Prompt preparation queue", { timeout: 15_000 }, async (t) => {
  const retryEntered = Promise.withResolvers<void>();
  const releaseRetry = Promise.withResolvers<void>();
  const f = fixture(undefined, undefined, async () => {
    retryEntered.resolve();
    await releaseRetry.promise;
  });
  const other = { ...prompt, intentId: "other-intent" };
  const handlers: Promise<Response | null>[] = [];
  let released = false;
  const release = () => {
    released = true;
    releaseRetry.resolve();
  };
  // This watchdog only unblocks a failing implementation. Passing requires the
  // ordinary handler's real response before the held retry is released.
  const watchdog = setTimeout(release, 5_000);
  t.signal.addEventListener("abort", release, { once: true });
  let enteredBeforeCompletion = false;
  let ordinaryCompletedWhileHeld = false;
  let ordinaryResponse: Response | null | undefined;
  let during: string[] = [];
  let outcomes: PromiseSettledResult<Response | null>[] = [];
  try {
    await f.handler(request("/prompts", "POST", prompt, promptHeaders()));
    await f.coordinator.settled("session-1", prompt.intentId);
    f.calls.length = 0;
    f.preparedInputs.length = 0;
    const retry = f.handler(
      request("/prompts?action=retry", "POST", prompt, promptHeaders()),
    );
    handlers.push(retry);
    const retryOutcome = retry.then(
      () => "completed" as const,
      () => "completed" as const,
    );
    enteredBeforeCompletion = await Promise.race([
      retryEntered.promise.then(() => true),
      retryOutcome.then(() => false),
    ]);
    const ordinary = f.handler(request("/prompts", "POST", other, {
      ...promptHeaders(), "idempotency-key": other.intentId,
    }));
    handlers.push(ordinary);
    ordinaryResponse = await ordinary;
    ordinaryCompletedWhileHeld = enteredBeforeCompletion && !released;
    during = [...f.calls];
  } finally {
    release();
    outcomes = await Promise.allSettled(handlers);
    await Promise.all([
      f.coordinator.settled("session-1", prompt.intentId),
      f.coordinator.settled("session-1", other.intentId),
    ]);
    clearTimeout(watchdog);
    t.signal.removeEventListener("abort", release);
  }
  assert.equal(enteredBeforeCompletion, true, "The explicit action did not enter retryPrepared");
  assert.equal(ordinaryCompletedWhileHeld, true, "A retry query held the global Prompt preparation queue");
  assert.equal(ordinaryResponse?.status, 202);
  assert.deepEqual(during, [
    "authorize:session-1", "retry", "authorize:session-1", "submit:other-intent", "release",
  ]);
  assert.equal(outcomes.length, 2);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, "fulfilled");
    if (outcome.status === "fulfilled") assert.equal(outcome.value?.status, 202);
  }
  assert.equal(f.calls.filter((call) => call === "release").length, 2);
});

function heldPreparationFixture(ordinal: number, signal: AbortSignal) {
  const preparationEntered = Promise.withResolvers<void>();
  const preparationGate = Promise.withResolvers<void>();
  const queryEntered = Promise.withResolvers<void>();
  const queryGate = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const dispatchEntered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const dispatches: Array<{
    input: PromptIntent;
    task: Promise<unknown>;
    finish(value: unknown): void;
    finished: boolean;
  }> = [];
  const queries: Array<Promise<{ kind: "unknown" }>> = [];
  const handlers: Array<Promise<Response | null>> = [];
  let preparationReleased = false;
  let closing = false;
  let watchdogFired = false;
  const releasePreparation = () => {
    preparationReleased = true;
    preparationGate.resolve();
  };
  const releaseAll = () => {
    closing = true;
    stopped.resolve();
    queryGate.resolve();
    releasePreparation();
    for (const dispatch of dispatches) dispatch.finish(undefined);
  };
  // Failure cleanup only: every passing checkpoint below has an actual entry,
  // handler or ACP settlement receipt while preparation is still held.
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    releaseAll();
  }, 5_000);
  signal.addEventListener("abort", releaseAll, { once: true });
  const f = fixture(undefined, undefined, undefined, {
    prompt(input) {
      const completion = Promise.withResolvers<unknown>();
      const dispatch = {
        input: structuredClone(input),
        task: completion.promise,
        finish: completion.resolve,
        finished: false,
      };
      dispatch.task = completion.promise.then((result) => {
        dispatch.finished = true;
        return result;
      });
      dispatches.push(dispatch);
      dispatchEntered[dispatches.length - 1]?.resolve();
      if (closing || dispatches.length > 2) dispatch.finish(undefined);
      return dispatch.task;
    },
    readIntent() {
      const query = queryGate.promise.then(() => ({ kind: "unknown" as const }));
      queries.push(query);
      queryEntered.resolve();
      return query;
    },
    async afterPrepared(_input, current) {
      if (current !== ordinal) return;
      preparationEntered.resolve();
      await preparationGate.promise;
    },
  });
  return {
    ...f, dispatches, queries, dispatchEntered, preparationEntered, queryEntered,
    releaseQuery: () => queryGate.resolve(),
    releasePreparation,
    preparationReleased: () => preparationReleased,
    watchdogFired: () => watchdogFired,
    start(retry: boolean) {
      const task = f.handler(request(`/prompts${retry ? "?action=retry" : ""}`, "POST", prompt, promptHeaders()));
      handlers.push(task);
      void task.catch(() => {});
      return task;
    },
    progress(entered: Promise<void>, completed?: Promise<unknown>): Promise<boolean> {
      const choices = [entered.then(() => true), stopped.promise.then(() => false)];
      if (completed) choices.push(completed.then(() => false, () => false));
      return Promise.race(choices);
    },
    async close() {
      releaseAll();
      const outcomes = await Promise.allSettled(handlers);
      await Promise.allSettled(queries);
      for (const dispatch of dispatches) dispatch.finish(undefined);
      await Promise.allSettled(dispatches.map((dispatch) => dispatch.task));
      await f.coordinator.settled("session-1", prompt.intentId);
      clearTimeout(watchdog);
      signal.removeEventListener("abort", releaseAll);
      return outcomes;
    },
  };
}

test("retry requests admitted before preparation share one decision after its ACP call has settled", { timeout: 15_000 }, async (t) => {
  const f = heldPreparationFixture(3, t.signal);
  let originalEntered = false;
  let queryObserved = false;
  let secondPreparationHeld = false;
  let bothTicketsAdmitted = false;
  let additionalCallSettledWhileHeld = false;
  let outcomes: Array<PromiseSettledResult<Response | null>> = [];
  try {
    const original = f.start(false);
    await original;
    originalEntered = await f.progress(f.dispatchEntered[0]!.promise);
    f.dispatches[0]?.finish(undefined);
    await f.dispatches[0]?.task;
    await f.coordinator.settled("session-1", prompt.intentId);
    const first = f.start(true);
    queryObserved = await f.progress(f.queryEntered.promise, first);
    const second = f.start(true);
    secondPreparationHeld = await f.progress(f.preparationEntered.promise, second) &&
      !f.preparationReleased();
    bothTicketsAdmitted = f.retryTickets.length === 2 && secondPreparationHeld;
    f.releaseQuery();
    await first;
    if (queryObserved) {
      const additionalEntered = await f.progress(f.dispatchEntered[1]!.promise);
      if (additionalEntered) {
        f.dispatches[1]?.finish(undefined);
        await f.dispatches[1]?.task;
        await f.coordinator.settled("session-1", prompt.intentId);
        additionalCallSettledWhileHeld = f.dispatches[1]?.finished === true &&
          !f.preparationReleased();
      }
    }
    f.releasePreparation();
    await second;
  } finally {
    outcomes = await f.close();
  }
  assert.equal(f.watchdogFired(), false);
  assert.equal(originalEntered, true);
  assert.equal(queryObserved, true, "The first retry must query the original intent");
  assert.equal(secondPreparationHeld, true);
  assert.equal(bothTicketsAdmitted, true, "Both HTTP actions must enter before the held preparation finishes");
  assert.equal(additionalCallSettledWhileHeld, true, "The first retry's actual ACP call must settle before releasing the second preparation");
  assert.equal(f.queries.length, 1, "The second already-admitted action must retain the first decision");
  assert.deepEqual(f.dispatches.map((dispatch) => dispatch.input), [
    { sessionId: "session-1", ...prompt },
    { sessionId: "session-1", ...prompt },
  ], "Concurrent HTTP retries must produce only one additional original Prompt dispatch");
  assert.equal(f.forwardedTickets.length, 2);
  assert.equal(f.forwardedTickets[0], f.retryTickets[0]);
  assert.equal(f.forwardedTickets[1], f.retryTickets[1]);
  assert.equal(outcomes.length, 3);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, "fulfilled");
    if (outcome.status === "fulfilled") assert.equal(outcome.value?.status, 202);
  }
  assert.equal(f.dispatches.every((dispatch) => dispatch.finished), true);
  assert.equal(f.calls.filter((call) => call === "release").length, 3);
});

test("a retry admitted while its original ACP call is in flight cannot queue replay during preparation", { timeout: 15_000 }, async (t) => {
  const f = heldPreparationFixture(2, t.signal);
  let originalEntered = false;
  let preparationHeld = false;
  let ticketEnteredWhileOriginalPending = false;
  let originalSettledWhileHeld = false;
  let outcomes: Array<PromiseSettledResult<Response | null>> = [];
  try {
    await f.start(false);
    originalEntered = await f.progress(f.dispatchEntered[0]!.promise);
    const retry = f.start(true);
    preparationHeld = await f.progress(f.preparationEntered.promise, retry) &&
      !f.preparationReleased();
    ticketEnteredWhileOriginalPending = preparationHeld && f.retryTickets.length === 1 &&
      f.dispatches[0]?.finished === false;
    f.dispatches[0]?.finish(undefined);
    await f.dispatches[0]?.task;
    await f.coordinator.settled("session-1", prompt.intentId);
    originalSettledWhileHeld = f.dispatches[0]?.finished === true && !f.preparationReleased();
    f.releaseQuery();
    f.releasePreparation();
    await retry;
  } finally {
    outcomes = await f.close();
  }
  assert.equal(f.watchdogFired(), false);
  assert.equal(originalEntered, true);
  assert.equal(preparationHeld, true);
  assert.equal(ticketEnteredWhileOriginalPending, true);
  assert.equal(originalSettledWhileHeld, true);
  assert.deepEqual(f.dispatches.map((dispatch) => dispatch.input), [
    { sessionId: "session-1", ...prompt },
  ], "Finishing the original during preparation must not enable a queued replay");
  assert.equal(f.forwardedTickets.length, 1);
  assert.equal(f.forwardedTickets[0], f.retryTickets[0]);
  assert.equal(outcomes.length, 2);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, "fulfilled");
    if (outcome.status === "fulfilled") assert.equal(outcome.value?.status, 202);
  }
  assert.equal(f.dispatches.every((dispatch) => dispatch.finished), true);
  assert.equal(f.calls.filter((call) => call === "release").length, 2);
});
