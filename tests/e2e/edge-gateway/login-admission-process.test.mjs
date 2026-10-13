import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { durablePath } from "../../support/storage.mjs";
import {
  claimClient,
  releaseClient,
  cancelClient,
} from "./login-admission-process.mjs";

test("cancellation before process ownership is published fences every later start", async (t) => {
  const directory = durablePath(
    `artifacts/verification/login-admission-process/${randomUUID()}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal((await cancelClient({ directory })).joined, true);
  assert.throws(
    () =>
      claimClient(directory, { pid: process.pid, script: "/test-client.mjs" }),
    /cancelled/,
  );
  assert.equal((await cancelClient({ directory })).state, "idle");
});

for (const ignoresTerm of [false, true])
  test(`cancel joins the actual client process (ignores SIGTERM=${ignoresTerm})`, async (t) => {
    const directory = durablePath(
      `artifacts/verification/login-admission-process/${randomUUID()}`,
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const code = `${ignoresTerm ? "process.on('SIGTERM', () => {});" : ""} process.stdout.write('ready'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await closed;
      rmSync(directory, { recursive: true, force: true });
    });
    await once(child.stdout, "data");
    const owner = claimClient(directory, {
      pid: child.pid,
      script: process.execPath,
    });
    const result = await cancelClient({
      directory,
      graceMs: 30,
      joinMs: 3000,
      readCommand: () => [process.execPath, "-e", code],
    });
    assert.equal(result.joined, true);
    assert.equal(result.forced, ignoresTerm);
    await closed;
    assert.throws(() => process.kill(owner.pid, 0), { code: "ESRCH" });
    assert.equal((await cancelClient({ directory })).state, "idle");
  });

test("an ownership mismatch never signals an unrelated process", async (t) => {
  const directory = durablePath(
    `artifacts/verification/login-admission-process/${randomUUID()}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const owner = claimClient(directory, {
    pid: process.pid + 1000,
    script: "/test-client.mjs",
  });
  let signalled = false;
  await assert.rejects(
    cancelClient({
      directory,
      readCommand: () => ["unrelated-process"],
      kill: () => {
        signalled = true;
      },
    }),
  );
  assert.equal(signalled, false);
  releaseClient(directory, owner);
});
