import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAccess, createCloseoutAccessModel } from "./access-model.mjs";

const payload = (phase, results = []) => ({
  model: "closeout-access",
  messages: [
    { role: "user", content: phase },
    ...results.map((content) => ({ role: "tool", content })),
  ],
  tools: [{ function: { name: "bash" } }],
});
for (const version of [1, 2]) {
  test(`v${version} access model requires one exact physical append`, () => {
    for (const owner of ["owner", "peer", "foreign", "restored"]) {
      const phase = `v${version}-${owner}`;
      const first = decideAccess(payload(phase));
      assert.equal(first.call.name, "bash");
      assert(
        first.call.arguments.command.includes(`>> /workspace/${phase}.log`),
      );
      const tool = {
        effect_state: "settled",
        truncated: false,
        exit_code: 0,
        stdout: `${phase}\n`,
        stderr: "",
      };
      assert.equal(
        decideAccess(payload(phase, [JSON.stringify(tool)])).text,
        `Private history ${phase}`,
      );
      for (const bad of [
        { ...tool, stdout: `${phase}\n${phase}\n` },
        { ...tool, exit_code: 1 },
        { ...tool, truncated: true },
        { ...tool, effect_state: "unknown" },
        { ...tool, stdout: "foreign" },
      ])
        assert.throws(() =>
          decideAccess(payload(phase, [JSON.stringify(bad)])),
        );
      assert.throws(() =>
        decideAccess(
          payload(phase, [JSON.stringify(tool), JSON.stringify(tool)]),
        ),
      );
    }
    assert.throws(() => decideAccess(payload(`v${version}-unauthorized`)));
  });
}
test("real HTTP fixture binds both requests to actual traceparents and rejects repeat effects", async () => {
  const server = createCloseoutAccessModel();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (body, span, auth = "Bearer closeout-access-private-key") =>
      fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: auth,
          traceparent: `00-${"a".repeat(32)}-${span.repeat(16)}-01`,
        },
        body: JSON.stringify(body),
      });
    assert.equal((await send(payload("v1-owner"), "b")).status, 200);
    assert.equal(
      (
        await send(
          payload("v1-owner", [
            JSON.stringify({
              effect_state: "settled",
              truncated: false,
              exit_code: 0,
              stdout: "v1-owner\n",
              stderr: "",
            }),
          ]),
          "c",
        )
      ).status,
      200,
    );
    const state = await (await fetch(`${base}/status`)).json();
    assert.deepEqual(state.errors, []);
    assert.deepEqual(
      state.requests.map((r) => [r.stage, r.model_span_id]),
      [
        ["tool", "b".repeat(16)],
        ["reply", "c".repeat(16)],
      ],
    );
    assert.equal((await send(payload("v1-owner"), "d")).status, 400);
    assert.equal(
      (await send(payload("v1-peer"), "e", "Bearer wrong-key")).status,
      400,
    );
    assert.equal(
      (await (await fetch(`${base}/status`)).json()).requests.length,
      2,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fresh Session model context rejects another Session's messages", () => {
  for (const foreign of [
    { role: "user", content: "v1-foreign" },
    { role: "assistant", content: "Private history v2-peer" },
    { role: "system", content: "Private history v1-foreign" },
  ]) {
    const body = payload("v1-owner");
    body.messages.unshift(foreign);
    assert.throws(() => decideAccess(body));
  }
});
