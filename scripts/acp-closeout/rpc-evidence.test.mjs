import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseRequest } from "../observability/trace-fixtures.mjs";
import {
  assertReceipts,
  assertTerminal,
  assertConfiguredReplay,
  inspectRpcTrace,
} from "./rpc-evidence.mjs";

for (const version of [1, 2])
  test(`v${version}: setup restores current configuration without replaying obsolete configuration events`, () => {
    const configuration = [
      {
        sessionId: "session",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [{ id: "mode", currentValue: "auto" }],
        },
      },
    ];
    if (version === 1)
      configuration.push({
        sessionId: "session",
        update: { sessionUpdate: "current_mode_update", currentModeId: "auto" },
      });
    const catalog = {
      sessionId: "session",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "help", description: "Also /帮助" }],
      },
    };
    const persisted = [
      {
        kind: "configuration",
        visible: true,
        payload: {
          kind: "configuration",
          configurationJson: JSON.stringify({ modeId: "auto" }),
        },
      },
    ];
    const frames = [catalog];
    const setup = { configOptions: configuration[0].update.configOptions };
    const loaded = {
      ...setup,
      ...(version === 1 ? { modes: { currentModeId: "auto" } } : {}),
    };
    assertConfiguredReplay(frames, persisted, version, setup, loaded);
    for (const invalid of [
      [],
      [catalog, ...configuration],
      [...configuration, ...frames],
    ])
      assert.throws(() =>
        assertConfiguredReplay(invalid, persisted, version, setup, loaded),
      );
    const changed = structuredClone(loaded);
    changed.configOptions[0].currentValue = "ask";
    assert.throws(() =>
      assertConfiguredReplay(frames, persisted, version, setup, changed),
    );
  });

for (const kind of ["acquire", "finish"])
  test(`${kind}: acceptance requires an exact committed retry, never another admission or changed terminal`, () => {
    const base = {
      agent_id: "agent",
      session_id: "session",
      admission_id: "admission",
      status: 200,
      delivery: "delivered",
      semantic_hash: "semantic",
      response_hash: "response",
      request_id: "request",
      traceparent: `00-${"1".repeat(32)}-${"2".repeat(16)}-01`,
    };
    const acquire = {
      ...base,
      method: "acquire-run",
      execution_revision: "execution",
    };
    const finish = {
      ...base,
      method: "finish-run",
      request_id: "finish",
      finish_status: "finished",
      admission_state: "released",
    };
    const original = {
      ...(kind === "acquire" ? acquire : finish),
      delivery: "held",
    };
    const dropped = { ...original, delivery: "dropped" };
    const retried = {
      ...original,
      delivery: "delivered",
      traceparent: `00-${"3".repeat(32)}-${"4".repeat(16)}-01`,
      ...(kind === "finish"
        ? { request_id: "retry", finish_status: "already_finished" }
        : {}),
    };
    const records =
      kind === "acquire"
        ? [dropped, retried, finish]
        : [acquire, dropped, retried];
    assertReceipts(kind, original, records);
    const sameTrace = structuredClone(records);
    sameTrace.find(
      (item) =>
        item.method === original.method && item.delivery === "delivered",
    ).traceparent = original.traceparent;
    assert.throws(() => assertReceipts(kind, original, sameTrace));
    for (const key of [
      "admission_id",
      "session_id",
      "semantic_hash",
      "delivery",
      "status",
    ]) {
      const invalid = structuredClone(records);
      Object.assign(
        invalid.find(
          (item) =>
            item.method === original.method && item.delivery === "delivered",
        ),
        { [key]: "wrong" },
      );
      assert.throws(() => assertReceipts(kind, original, invalid));
    }

    for (const invalid of [
      records.slice(1),
      [...records, retried],
      records.map((item) =>
        item === dropped ? { ...item, delivery: "lost_before_drop" } : item,
      ),
    ])
      assert.throws(() => assertReceipts(kind, original, invalid));
    const invalid = structuredClone(records);
    const retry = invalid.find(
      (item) =>
        item.method === original.method && item.delivery === "delivered",
    );
    retry[kind === "acquire" ? "response_hash" : "finish_status"] = "different";
    assert.throws(() => assertReceipts(kind, original, invalid));
  });

for (const kind of ["acquire", "finish"])
  for (const replay of [false, true])
    test(`${kind} trace proves CLIENT/SERVER/DB parentage and receipt replay semantics`, () => {
      const id = "1".repeat(32),
        rpcID = "2".repeat(16);
      const tags = (value) =>
        Object.entries(value).map(([key, value]) => ({ key, value }));
      const receipt = {
        traceparent: `00-${id}-${rpcID}-01`,
        method: `${kind}-run`,
        request_id: "request",
        agent_id: "agent",
        session_id: "session",
        admission_id: "admission",
        semantic_hash: "semantic",
        response_hash: "response",
        snapshot_hash: "snapshot",
        execution_revision: "execution",
        status: 200,
        delivery: replay ? "delivered" : "dropped",
        admission_state: "released",
        finish_status: replay ? "already_finished" : "finished",
      };
      const original = {
        ...receipt,
        delivery: "held",
        finish_status: "finished",
        traceparent: replay
          ? `00-${"3".repeat(32)}-${rpcID}-01`
          : receipt.traceparent,
      };
      const child = (parent) => [
        { refType: "CHILD_OF", traceID: id, spanID: parent },
      ];
      const trace = {
        traceID: id,
        processes: {
          edge: { serviceName: "edge-gateway" },
          acp: { serviceName: "agent-acp-service" },
          controller: { serviceName: "agent-controller" },
        },
        spans: [
          {
            spanID: "edge",
            traceID: id,
            processID: "edge",
            operationName: "GET ACP",
            references: [],
          },
          {
            spanID: "adapter",
            traceID: id,
            processID: "acp",
            operationName: `agent_controller.${kind}_run`,
            references: replay ? [] : child("edge"),
            tags: tags({ "request.id": "request" }),
          },
          {
            spanID: rpcID,
            traceID: id,
            processID: "acp",
            operationName: "HTTP POST agent-controller",
            references: child("adapter"),
            tags: tags({
              "span.kind": "client",
              "http.request.method": "POST",
            }),
          },
          ...databaseRequest(
            id,
            "server",
            rpcID,
            "controller",
            `/rpc/agent-controller/${kind}-run`,
          ),
        ],
      };
      inspectRpcTrace(trace, receipt, replay, [], original);
      if (replay) {
        const inherited = structuredClone(trace);
        inherited.spans[1].references = child("edge");
        assert.throws(() =>
          inspectRpcTrace(inherited, receipt, replay, [], original),
        );
      }
      for (const mutate of [
        (t) => {
          t.spans[2].references = [];
        },
        (t) => {
          t.spans[2].references[0].traceID = "foreign";
        },
        (t) => {
          t.spans[1].tags = tags({ "request.id": "foreign" });
        },
        (t) => {
          t.spans[2].tags = [];
        },
        (t) => {
          t.spans[3].processID = "acp";
        },
        (t) => {
          t.spans.pop();
        },
        (t) => {
          t.spans.push({ ...t.spans[3], spanID: "duplicate-server" });
        },
        (t) => {
          t.spans[4].references = [];
        },
        (t) => {
          t.spans[3].warnings = ["missing parent"];
        },
      ]) {
        const invalid = structuredClone(trace);
        mutate(invalid);
        assert.throws(() =>
          inspectRpcTrace(invalid, receipt, replay, [], original),
        );
      }
      assert.throws(() => inspectRpcTrace(trace, receipt, replay));
      for (const key of [
        "admission_id",
        "session_id",
        "semantic_hash",
        ...(kind === "acquire"
          ? ["response_hash", "snapshot_hash", "execution_revision"]
          : ["admission_state", "finish_status"]),
      ])
        assert.throws(() =>
          inspectRpcTrace(
            trace,
            { ...receipt, [key]: "wrong" },
            replay,
            [],
            original,
          ),
        );
    });

test("identical Finish retries must still match the durable terminal", () => {
  const terminal = {
    terminal_class: "completed",
    tool_effect_state: "settled",
    stop_reason: "end_turn",
    unknown_effect_source: null,
    error_class: null,
  };
  const records = [0, 1].map(() => ({ method: "finish-run", ...terminal }));
  assertTerminal(records, terminal);
  for (const key of Object.keys(terminal)) {
    const wrong = records.map((record) => ({ ...record, [key]: "wrong" }));
    assert.throws(() => assertTerminal(wrong, terminal));
  }
});
