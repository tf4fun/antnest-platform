import assert from "node:assert/strict";
import { test } from "node:test";
import { createConfigurationHandler } from "../src/http/configuration-routes.ts";
import { SessionNotFoundError } from "../src/adapters/acp-http.ts";

const path =
  "http://localhost/api/app/workspace/v1/agents/agent-1/sessions/session-1/configuration";
const headers = {
  "x-antnest-organization-id": "org-1",
  "x-antnest-principal-id": "user-1",
  "x-antnest-agent-id": "agent-1",
  "content-type": "application/json",
};

test("configuration route accepts SDK select and boolean values under trusted scope", async () => {
  const calls: unknown[] = [];
  const handler = createConfigurationHandler({
    async apply(_scope, sessionId, configId, value, token) {
      calls.push([sessionId, configId, value, token]);
      return { sessionId, configOptions: [] };
    },
  });
  const body = JSON.stringify({
    configId: "auto",
    value: false,
    expectedConfigurationToken: "opaque",
  });
  assert.equal(
    (await handler(new Request(path, { method: "POST", body })))?.status,
    401,
  );
  assert.equal(
    (
      await handler(
        new Request(path, {
          method: "POST",
          headers,
          body: JSON.stringify({
            configId: "auto",
            value: 1,
            expectedConfigurationToken: "opaque",
          }),
        }),
      )
    )?.status,
    422,
  );
  const response = await handler(
    new Request(path, { method: "POST", headers, body }),
  );
  assert.equal(response?.status, 200);
  assert.deepEqual(calls, [["session-1", "auto", false, "opaque"]]);
});

test("configuration of a deleted Session returns permanent absence", async () => {
  const handler = createConfigurationHandler({
    async apply() { throw new SessionNotFoundError(); },
  });
  const response = await handler(new Request(path, { method: "POST", headers,
    body: JSON.stringify({ configId: "auto", value: false,
      expectedConfigurationToken: "opaque" }) }));
  assert.equal(response?.status, 404);
  assert.equal((await response?.json()).code, "session_not_found");
});
