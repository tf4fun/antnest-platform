import assert from "node:assert/strict";
import test from "node:test";
import { stage3TraceInput } from "./stage3-trace.mjs";

const traceID = "a".repeat(32);
const operation = {
  request_id: "req",
  agent_id: "agent",
  kind: "create",
  state: "completed",
};
const jar = [
  "# Netscape HTTP Cookie File",
  "#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t0\tantnest_session\tsynthetic/session+value=",
  "127.0.0.1\tFALSE\t/\tFALSE\t0\tantnest_csrf\tsynthetic-csrf",
  "",
].join("\r\n");

test("Stage 3 input preserves exact admission and terminal operation identity", () => {
  const input = stage3TraceInput(traceID, operation, jar);
  assert.deepEqual(input.operation, {
    traceID,
    requestID: "req",
    agentID: "agent",
    kind: "create",
  });
  for (const value of [
    "synthetic/session+value=",
    "synthetic-csrf",
    "stage3-model-secret",
    "stage3-admin-password",
  ])
    assert(input.secrets.includes(value));
});

for (const [name, id, op, cookies] of [
  ["missing admission", "", operation, jar],
  ["missing owner", traceID, { ...operation, agent_id: "" }, jar],
  ["nonterminal operation", traceID, { ...operation, state: "running" }, jar],
  ["missing cookies", traceID, operation, "# empty jar"],
  [
    "missing CSRF",
    traceID,
    operation,
    jar
      .split("\r\n")
      .filter((line) => !line.includes("antnest_csrf"))
      .join("\n"),
  ],
  [
    "empty session",
    traceID,
    operation,
    jar.replace("synthetic/session+value=", ""),
  ],
])
  test(`Stage 3 refuses ${name}`, () => {
    assert.throws(() => stage3TraceInput(id, op, cookies));
  });
