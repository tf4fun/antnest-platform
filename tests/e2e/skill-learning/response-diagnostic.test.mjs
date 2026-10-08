import assert from "node:assert/strict";
import { test } from "node:test";

import { unexpectedStatus } from "./response-diagnostic.mjs";

const response = (status, body) => ({
  status: () => status,
  text: async () => body,
});

test("an unexpected status names the error code and retryability", async () => {
  assert.equal(
    await unexpectedStatus(
      "skill source preview",
      response(
        503,
        JSON.stringify({
          code: "dependency_unavailable",
          message: "Registry source unavailable",
          retryable: true,
        }),
      ),
    ),
    "skill source preview: HTTP 503 code=dependency_unavailable retryable=true",
  );
});

test("free-form error text and non-JSON bodies never reach the message", async () => {
  const secret = "placeholder-detail-xxxxxxxx";
  assert.equal(
    await unexpectedStatus(
      "preview",
      response(502, JSON.stringify({ message: secret })),
    ),
    "preview: HTTP 502 code=none retryable=unknown",
  );
  assert.equal(
    await unexpectedStatus("preview", response(500, `<html>${secret}</html>`)),
    "preview: HTTP 500 code=none retryable=unknown",
  );
  assert.equal(
    await unexpectedStatus(
      "preview",
      response(503, JSON.stringify({ code: `bad ${secret}` })),
    ),
    "preview: HTTP 503 code=invalid retryable=unknown",
  );
});

test("an unreadable body still reports the status", async () => {
  assert.equal(
    await unexpectedStatus("preview", {
      status: () => 503,
      text: async () => {
        throw new Error("body already consumed");
      },
    }),
    "preview: HTTP 503 code=none retryable=unknown",
  );
});
