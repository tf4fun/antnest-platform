import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { decide } from "./c4-model.mjs";

const phase = "c4-cache-runtime-outage";
const marker = `${phase}: runtime output during identity outage.`;
const payload = () => ({
  model: "stage3-model",
  messages: [{ role: "user", content: phase }],
  tools: [{ function: { name: "bash" } }],
});

test("Bridge outage immediately dispatches actual bash work rather than holding a model response", () => {
  const decision = decide(payload());
  assert.equal(decision.phase, phase);
  assert.equal(decision.hold, undefined);
  assert.equal(decision.text, undefined);
  assert.equal(decision.call.name, "bash");
  assert.equal(decision.call.arguments.working_dir, ".");
  assert.equal(decision.call.arguments.timeout_ms, 120000);
});

test("held Runtime output needs an explicit emit gate and emitting does not finish the work", async (t) => {
  const decision = decide(payload());
  const directory = await mkdtemp(join(tmpdir(), "antnest-cache-runtime-"));
  // Execute the actual dispatched command with only its mount location mapped
  // to a temporary directory. This tests the fixture, not Runtime cancellation.
  const command = decision.call.arguments.command.replaceAll(
    "/workspace/",
    `${directory}/`,
  );
  const child = spawn("bash", ["-c", command], { detached: true });
  const completion = once(child, "exit");
  let output = "",
    errors = "",
    stopped = false;
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (errors += chunk));
  const stop = async () => {
    if (stopped) return completion;
    stopped = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await completion;
  };
  t.after(async () => {
    try {
      await stop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const wait = async (check) => {
    const deadline = performance.now() + 3000;
    for (;;) {
      const result = await check();
      if (result) return result;
      assert.equal(child.exitCode, null, `work exited early: ${errors}`);
      assert.equal(child.signalCode, null, `work stopped early: ${errors}`);
      assert(performance.now() < deadline, "fixture observation timed out");
      await delay(10);
    }
  };
  const text = (suffix) =>
    readFile(join(directory, `.${phase}-${suffix}`), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
  await wait(async () => (await text("started")) === String(child.pid));
  assert.equal(await text("effects"), "started\n");
  assert.equal(output, "");
  await writeFile(join(directory, `.${phase}-emit`), "");
  await wait(() => output.includes(marker));
  assert.equal(output, marker + "\n");
  assert.equal(await text("effects"), "started\nemitted\n");
  // A former release file must never turn this held work into successful
  // completion: the owning test must cancel the same Run through Bridge.
  await writeFile(join(directory, `.${phase}-release`), "");
  await delay(150);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(output, marker + "\n");
  await stop();
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(await text("effects"), "started\nemitted\n");
});

for (const [name, change] of [
  ["missing real bash", (value) => (value.tools = [])],
  [
    "model continuation after a tool result",
    (value) =>
      value.messages.push({
        role: "tool",
        tool_call_id: "unexpected",
        content: JSON.stringify({ exit_code: 0, effect_state: "settled" }),
      }),
  ],
]) {
  test(`held Runtime fixture rejects ${name}`, () => {
    const value = payload();
    assert.doesNotThrow(() => decide(value));
    change(value);
    assert.throws(() => decide(value));
  });
}
