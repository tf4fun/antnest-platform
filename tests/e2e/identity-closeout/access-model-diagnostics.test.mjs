import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createAccessModel } from "./agent-access-model.mjs";
import { createCloseoutAccessModel } from "../acp-closeout/access-model.mjs";

for (const profile of [
  {
    name: "organization access",
    create: createAccessModel,
    credential: "Bearer scope-credential-a",
    body: {
      model: "scope-a",
      messages: [
        { role: "system", content: "Private organization a guidance" },
        { role: "user", content: "v1-a" },
      ],
    },
  },
  {
    name: "Closeout access",
    create: createCloseoutAccessModel,
    credential: "Bearer closeout-access-private-key",
    body: {
      model: "closeout-access",
      messages: [{ role: "user", content: "v1-owner" }],
      tools: [{ function: { name: "bash" } }],
    },
  },
]) {
  for (const parent of [
    undefined,
    "unavailable",
    `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  ]) {
    test(`${profile.name} HTTP keeps Trace auxiliary (${parent === undefined ? "missing" : parent === "unavailable" ? "invalid" : "valid"})`, async () => {
      const server = profile.create().listen(0, "127.0.0.1");
      await once(server, "listening");
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const send = (body, authorization = profile.credential) =>
          fetch(`${base}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization,
              ...(parent === undefined ? {} : { traceparent: parent }),
            },
            body: JSON.stringify(body),
          });
        assert.equal((await send(profile.body, "Bearer wrong")).status, 400);
        assert.equal(
          (await send({ ...profile.body, model: "foreign" })).status,
          400,
        );
        const response = await send(profile.body);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).choices.length, 1);
        let state = await (await fetch(`${base}/status`)).json();
        assert.equal(state.requests.length, 1);
        const receipt = state.requests[0];
        if (parent?.startsWith("00-")) {
          assert.equal(receipt.trace_id, "a".repeat(32));
          assert.equal(receipt.model_span_id, "b".repeat(16));
        } else {
          assert.equal(receipt.trace_id, undefined);
          assert.equal(receipt.model_span_id, undefined);
          assert.equal(receipt.trace_diagnostic, "traceparent_unavailable");
        }
        assert.equal((await send(profile.body)).status, 400);
        state = await (await fetch(`${base}/status`)).json();
        assert.equal(
          state.requests.length,
          1,
          "duplicate or rejected Provider work was admitted",
        );
        assert.equal(state.errors.length, 3);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  }
}
