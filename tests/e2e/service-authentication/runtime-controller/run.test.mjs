import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("registration recovery verifies the Runtime before exercising authenticated deletion", async () => {
  const source = await readFile(new URL("./run.mjs", import.meta.url), "utf8");
  const start = source.indexOf("  const recovered = await mutate(");
  const end = source.indexOf("  checks += 3;", start);
  assert(start > 0 && end > start);
  const events = [];
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    "mutate",
    "waitRuntime",
    "outageAgent",
    "configuration",
    "assert",
    source.slice(start, end),
  );
  let verified = false;
  await run(
    async (agent, action, body) => {
      assert.equal(agent, "fixture-agent");
      events.push(action);
      if (action === "delete") {
        assert(
          verified,
          "delete raced the fixture process startup and signal handlers",
        );
        assert.equal(body.expected_revision, "revision-1");
      }
      return { state: "completed", target_revision: "revision-1" };
    },
    async (agent) => {
      assert.equal(agent, "fixture-agent");
      events.push("verified");
      verified = true;
    },
    "fixture-agent",
    {},
    assert,
  );
  assert.deepEqual(events, ["initialize", "verified", "delete"]);
});
