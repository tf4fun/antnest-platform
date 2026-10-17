import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GatewayClient, assertNoStore } from "./support.mjs";
import { observeWorkspaceStream } from "../edge-gateway/resolve-cache-stream.mjs";
import {
  bridgeSessionCheckpoint,
  expectBridgeSessionClose,
} from "./bridge-session-close.mjs";

// The mutating browser may clear or rotate its Cookies. Keep the exact original
// authority for both the existing SSE and the later real HTTP rejection probe.
export async function observeBrowserSession(
  browser,
  client,
  { agentId, sessionId, issued, signal, membershipRevocation = false },
) {
  signal?.throwIfAborted();
  const expiresAt = Date.parse(issued?.expires_at),
    idleExpiresAt = Date.parse(issued?.idle_expires_at);
  assert(Number.isFinite(expiresAt) && expiresAt > 0);
  assert(Number.isFinite(idleExpiresAt) && idleExpiresAt > 0);
  for (const key of ["organization_id", "user_id"])
    assert(
      typeof issued.principal?.[key] === "string" && issued.principal[key],
    );
  const issuance = structuredClone(issued.observation);
  assert(
    Number.isFinite(issuance?.startedMono) &&
      Number.isFinite(issuance.completedMono),
  );
  assert(issuance.completedMono >= issuance.startedMono);
  assert.match(issuance.traceID ?? "", /^[a-f0-9]{32}$/u);
  assert(browser.cookie, "original browser session required");
  const original = new GatewayClient(browser.base, {
    onStatusFailure: browser.onStatusFailure,
  });
  original.cookies = new Map(browser.cookies);
  const cookie = original.cookie,
    credentialScope = randomUUID();
  let stream,
    point,
    closed,
    probed = false;
  try {
    stream = await observeWorkspaceStream(
      original,
      agentId,
      sessionId,
      signal,
      {
        credentialScope: (sent) => {
          assert(
            sent === cookie,
            "SSE dispatched a different browser authority",
          );
          return credentialScope;
        },
      },
    );
    await stream.wait((view) => view.selectedView?.sessionId === sessionId);
  } catch (error) {
    await stream?.closeAndWait();
    throw error;
  }
  return {
    principal: structuredClone(issued.principal),
    browser: original,
    stream,
    checkpoint(reason) {
      if (membershipRevocation) assert.equal(reason, "revoked");
      assert(!point, "one fault trigger per browser observation");
      assert(original.cookie === cookie, "original browser authority changed");
      point = bridgeSessionCheckpoint(original, client, stream, {
        agentId,
        sessionId,
        reason,
        expiresAt,
        idleExpiresAt,
      });
      assert(issuance.completedMono <= point.stream.started_at);
      point.issuance = structuredClone(issuance);
      return point;
    },
    async waitForClose(checkpoint) {
      assert(point && checkpoint === point, "foreign fault checkpoint");
      closed = await expectBridgeSessionClose(original, client, stream, point);
      return closed;
    },
    async rejectPrompt() {
      assert(
        closed && !probed,
        "one denial probe after observed remote closure required",
      );
      assert(original.cookie === cookie, "original browser authority changed");
      signal?.throwIfAborted();
      probed = true;
      const view = stream.records.at(-1).view.selectedView;
      assert.equal(view.agentId, agentId);
      assert.equal(view.sessionId, sessionId);
      assert(
        typeof view.historyToken === "string" && view.historyToken.length > 0,
      );
      assert(
        Number.isSafeInteger(view.appendVersion) && view.appendVersion >= 0,
      );
      const intentId = randomUUID();
      const path = `/api/app/workspace/v1/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/prompts`;
      const expectedStatus =
        point.reason === "unavailable"
          ? 503
          : membershipRevocation
            ? [401, 403]
            : 401;
      const expectedCode =
        point.reason === "unavailable"
          ? "identity_unavailable"
          : "unauthenticated";
      const startedMono = performance.now(),
        startedAt = Date.now();
      const response = await original.request(path, {
        status: expectedStatus,
        headers: { "If-Match": view.historyToken, "Idempotency-Key": intentId },
        body: {
          intentId,
          expectedAppendVersion: view.appendVersion,
          prompt: [{ type: "text", text: "denied-must-not-run" }],
        },
      });
      const completedMono = performance.now(),
        completedAt = Date.now();
      // Join the bounded HTTP request before observing cancellation; never leave
      // an abandoned denial probe running or report a cancelled check as passed.
      signal?.throwIfAborted();
      try {
        if (response.status === 403) {
          assert(membershipRevocation);
          assert(
            typeof response.body?.requestId === "string" &&
              response.body.requestId,
          );
          assert.deepEqual(response.body, {
            code: "access_denied",
            message: "Agent access denied",
            retryable: false,
            recovery: "none",
            requestId: response.body.requestId,
          });
        } else assert.equal(response.body?.code, expectedCode);
        assertNoStore(response.headers);
        assert.equal(response.headers.getSetCookie().length, 0);
        assert(original.cookie === cookie);
        assert.match(response.traceID ?? "", /^[a-f0-9]{32}$/u);
        const date = Date.parse(response.headers.get("date"));
        assert(
          Number.isFinite(date) &&
            new Date(date).toUTCString() === response.headers.get("date"),
        );
      } catch {
        throw new Error("Bridge denial response did not satisfy its contract");
      }
      return {
        path,
        method: "POST",
        status: response.status,
        code: response.body.code,
        ...(response.status === 403
          ? { body: structuredClone(response.body) }
          : {}),
        traceID: response.traceID,
        credentialScope,
        startedAt,
        completedAt,
        startedMono,
        completedMono,
        serverDate: response.headers.get("date"),
        setCookieCount: 0,
        noStore: true,
        intentId,
      };
    },
    closeAndWait: () => stream.closeAndWait(),
  };
}
