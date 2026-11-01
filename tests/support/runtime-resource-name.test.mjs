import assert from "node:assert/strict";
import test from "node:test";
import { runtimeResourceName } from "./runtime-resource-name.mjs";

test("fixture resource lookup includes Controller scope and resource kind", () => {
  assert.equal(
    runtimeResourceName("rc", "runtime", "agent-1"),
    "antnest-rc-runtime-agent-1",
  );
  assert.equal(
    runtimeResourceName("rc", "workspace", "agent-1"),
    "antnest-rc-workspace-agent-1",
  );
  assert.notEqual(
    runtimeResourceName("other", "runtime", "agent-1"),
    runtimeResourceName("rc", "runtime", "agent-1"),
  );
});
test("fixture lookup hashes ambiguous identifiers and respects Docker's resource limit", () => {
  assert.match(
    runtimeResourceName("east-runtime-wing", "runtime", "agent-1"),
    /^antnest-h-[a-f0-9]{32}-runtime-agent-1$/u,
  );
  const actual = runtimeResourceName(
    "s".repeat(400),
    "runtime",
    "a".repeat(400),
  );
  assert.match(actual, /^antnest-h-[a-f0-9]{32}-runtime-h-[a-f0-9]{32}$/u);
  assert.equal(actual.length, 85);
  for (const args of [
    ["", "runtime", "a"],
    ["rc", "invalid", "a"],
    ["rc", "runtime", ""],
  ])
    assert.throws(() => runtimeResourceName(...args));
});
