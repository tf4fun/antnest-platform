import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { inspectFoundationBusinessEvidence } from "./foundation-business.mjs";

const nonempty = (value, message) =>
  assert(typeof value === "string" && value.trim().length > 0, message);
const same = (actual, expected, message) =>
  assert(isDeepStrictEqual(actual, expected), message);

function originalSessions(evidence) {
  nonempty(evidence.agent_id, "original Foundation Agent required");
  nonempty(evidence.principal_id, "original Foundation Principal required");
  assert(Array.isArray(evidence.private_connections));
  const first = evidence.private_connections[0];
  assert(first && Array.isArray(first.evidence));
  assert(
    Array.isArray(first.raw_frames),
    "original new-session responses required",
  );
  const sessions = first.evidence.slice(0, 2).map((row) => {
    assert.equal(row.method, "session/new");
    assert.equal(row.outcome, "succeeded");
    nonempty(row.requestId, "original new-session SDK identity required");
    same(
      row.requestReceipt,
      {
        requestId: row.requestId,
        params: row.requestParams,
        result: row.requestResult,
      },
      "original new-session receipt required",
    );
    const session = row.requestReceipt.result?.sessionId;
    nonempty(session, "original new-session result required");
    same(row.sessionId, session, "new-session identity changed after receipt");
    const frames = first.raw_frames.filter(
      (frame) =>
        Object.hasOwn(frame, "id") &&
        String(frame.id) === row.requestId &&
        (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")),
    );
    assert.equal(
      frames.length,
      1,
      "one original new-session response required",
    );
    assert(!Object.hasOwn(frames[0], "error"), "new-session response failed");
    same(
      frames[0].result?.sessionId,
      session,
      "raw new-session identity changed",
    );
    return session;
  });
  assert.equal(sessions.length, 2, "both original Sessions required");
  assert.notEqual(sessions[0], sessions[1], "original Sessions overlap");
  return sessions;
}

function completePage(page, name) {
  assert(Array.isArray(page?.items), name + " items required");
  assert(page.items.length <= 100, name + " exceeds one evidence page");
  assert.equal(page.next_cursor, null, "complete " + name + " required");
}

export async function collectFoundationBusinessEvidence(
  input,
  { readJSON, preserve, signal } = {},
) {
  const evidence = {
    agent_id: input?.agent_id,
    principal_id: input?.principal_id,
    private_connections: input?.private_connections,
    execution_revisions: input?.execution_revisions,
    busy_checks: input?.busy_checks,
    provider_requests: input?.provider_requests,
    audits: [],
  };
  let summary;
  let failed = false;
  let failure;
  let archiveFailed = false;
  let archiveFailure;

  async function readInto(target, field, path) {
    signal?.throwIfAborted();
    // Await the real read, including its cancellation finally. Retain every
    // received DTO before checking cancellation; never invent an unread page.
    target[field] = await readJSON(path, { signal });
    signal?.throwIfAborted();
  }

  try {
    signal?.throwIfAborted();
    assert.equal(typeof readJSON, "function", "original Audit reader required");
    const sessions = originalSessions(evidence);
    for (const [index, session] of sessions.entries()) {
      const audit = { session_id: session, page: null, all: [] };
      evidence.audits.push(audit);
      await readInto(
        audit,
        "page",
        "/api/admin/execution-audits?agent_id=" +
          encodeURIComponent(evidence.agent_id) +
          "&session_id=" +
          encodeURIComponent(session) +
          "&limit=100",
      );
      completePage(audit.page, "Session Run page");
      assert.equal(
        audit.page.items.length,
        index === 0 ? 2 : 0,
        "original accepted/rejected Session Run inventory changed",
      );
      for (const item of audit.page.items) {
        nonempty(item.run_id, "original listed Run identity required");
        const path =
          "/api/admin/execution-audits/" + encodeURIComponent(item.run_id);
        const saved = { run: null, events: null };
        audit.all.push(saved);
        await readInto(saved, "run", path);
        await readInto(saved, "events", path + "/events?limit=100");
        completePage(saved.events, "Run execution event page");
      }
    }
    summary = inspectFoundationBusinessEvidence(evidence);
    signal?.throwIfAborted();
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      // The business archive is a hard gate and is joined even after ownership
      // loss. The caller preserves failure with its original error metadata.
      await preserve(evidence, failure);
    } catch (error) {
      archiveFailed = true;
      archiveFailure = error;
    }
  }

  const failures = [];
  if (failed) failures.push(failure);
  if (signal?.aborted && !failures.includes(signal.reason))
    failures.push(signal.reason);
  if (archiveFailed) failures.push(archiveFailure);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "Foundation business collection or archive failed",
    );
  return { evidence, summary };
}
