import assert from "node:assert/strict";
import { inspect } from "node:util";
import { validAgentView } from "../../../services/agent-ui/web/server/src/protocol/agent-view-delta.ts";
import { loadBridgeProcessPage } from "../../../services/agent-ui/web/src/lib/bridge-process.ts";
import { readTurnContent } from "../../support/agent-ui/bridge-protocol.mjs";
import { gatewaySessionCookies } from "../../support/gateway-session-cookies.mjs";
import { runC4BrowserScope } from "./c4-browser-scope.mjs";

// Admission is not completion. The selected view must contain this operation's
// original Run and its completed output, even if older turns are successful.
export function developmentCompletedTurn(view, receipt) {
  assert(validAgentView(view), "invalid Development Bridge view");
  assert.equal(view.agentId, receipt.agentId, "foreign Development Agent");
  assert.equal(
    view.selectedSessionId,
    receipt.sessionId,
    "foreign Development Session",
  );
  const session = view.selectedView;
  const matches = session.operations.filter(
    (item) => item.operationId === receipt.body.operationId,
  );
  assert(matches.length <= 1, "duplicate Development operation");
  const operation = matches[0];
  if (!operation) return null;
  assert(
    !["failed", "cancelled", "uncertain"].includes(operation.phase),
    "Development Prompt did not complete successfully",
  );
  if (operation.phase !== "completed") return null;
  assert.equal(
    operation.acceptance,
    "acp",
    "Development completion was not accepted by ACP",
  );
  assert.equal(operation.stopReason, "end_turn");
  assert(
    !operation.error && !operation.errorClass,
    "Development Prompt returned an error",
  );
  const turn = session.turns.find((item) => item.turnId === operation.runId);
  if (!turn) return null;
  assert(
    !["failed", "cancelled", "unknown"].includes(turn.outcome),
    "Development Run turn failed",
  );
  if (
    turn.outcome !== "completed" ||
    session.outputWatermark === null ||
    session.outputWatermark < operation.outputWatermark
  )
    return null;
  return { operation, turn };
}

export async function readDevelopmentTurn(
  config,
  sessionId,
  turn,
  evidence = {},
) {
  const { sessionName, csrfName, accessToken, csrf } = gatewaySessionCookies(
    config.cookies,
  );
  assert(
    accessToken && csrf,
    "original Development browser authority required",
  );
  const headers = {
    Cookie: `${sessionName}=${accessToken}; ${csrfName}=${csrf}`,
  };
  const signal = config.signal
    ? AbortSignal.any([config.signal, AbortSignal.timeout(30000)])
    : AbortSignal.timeout(30000);
  const base = new URL(
    `/api/app/workspace/v1/agents/${encodeURIComponent(config.agentId)}`,
    config.gateway,
  ).href;
  const content = await readTurnContent(base, sessionId, turn, headers, signal);
  evidence.content = structuredClone(content);
  const process = [],
    known = new Set(),
    cursors = new Set();
  evidence.process_pages = [];
  let cursor;
  const api = {
    async process(agent, session, run, after, requestSignal) {
      assert.equal(agent, config.agentId);
      const url = new URL(
        `${base}/sessions/${encodeURIComponent(session)}/turns/${encodeURIComponent(run)}/process`,
      );
      if (after !== undefined) url.searchParams.set("cursor", after);
      const response = await fetch(url, {
        headers,
        signal: requestSignal,
        redirect: "error",
      });
      const bytes = await response.arrayBuffer();
      const raw = new TextDecoder().decode(bytes);
      evidence.process_pages.push({
        url: url.href,
        status: response.status,
        rawBody: raw,
      });
      assert.equal(
        response.status,
        200,
        "Development process page HTTP status",
      );
      assert(
        bytes.byteLength <= 262144,
        "Development process page exceeds wire envelope",
      );
      return JSON.parse(raw);
    },
  };
  while (process.length < turn.processCount) {
    signal.throwIfAborted();
    assert(!cursors.has(cursor), "Development process cursor did not advance");
    cursors.add(cursor);
    const page = await loadBridgeProcessPage(
      api,
      config.agentId,
      sessionId,
      turn.turnId,
      turn.processVersion,
      turn.processCount,
      known,
      cursor,
      signal,
    );
    process.push(...page.items);
    for (const item of page.items) known.add(item.id);
    cursor = page.nextCursor;
  }
  evidence.process = structuredClone(process);
  return { content, process };
}

export function assertDevelopmentTurnContent(
  receipt,
  detail,
  { marker, requireTools = false } = {},
) {
  assert.deepEqual(
    detail.content.prompt,
    receipt.request.body.prompt,
    "Development turn belongs to another Prompt",
  );
  const text = detail.content.finalResponse
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  assert(text.trim(), "Empty assistant response in the original turn");
  if (marker)
    assert(
      text.includes(marker),
      "Original turn reply did not match the file marker",
    );
  if (requireTools)
    assert(
      detail.process.some(
        (item) => item.kind === "tool" && item.status === "completed",
      ),
      "Original turn has no completed Tool",
    );
  return text;
}

// Count requests, not successful responses: a failed implicit retry on reload
// still violates the no-resubmission contract.
export function observeDevelopmentRequests(page, records) {
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "POST" &&
      /^\/api\/app\/workspace\/v1\/agents\/[^/]+\/sessions\/[^/]+\/prompts$/u.test(
        url.pathname,
      )
    )
      records.push({
        url: url.href,
        method: request.method(),
        rawBody: request.postData(),
      });
  });
}

export function assertDevelopmentReload(
  before,
  after,
  requestCount,
  currentCount,
) {
  assert.equal(currentCount, requestCount, "Reload repeated prompt");
  assert.deepEqual(after, before, "Restored conversation differs");
}

export async function runDevelopmentBrowserScope(
  { launch, signal, report, preserve },
  work,
) {
  const errors = [];
  try {
    await runC4BrowserScope({ launch, signal }, work);
    report.status = "passed";
  } catch (error) {
    errors.push(error);
    report.status = "failed";
    report.errors = [inspect(error, { depth: 8 })];
  }
  try {
    await preserve(report);
  } catch (error) {
    errors.push(error);
    report.status = "failed";
  }
  if (signal?.aborted && !errors.includes(signal.reason)) {
    errors.push(signal.reason);
    report.status = "failed";
    report.errors = errors.map((error) => inspect(error, { depth: 8 }));
    try {
      await preserve(report);
    } catch (error) {
      if (!errors.includes(error)) errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Development browser or evidence failed");
  return report;
}
