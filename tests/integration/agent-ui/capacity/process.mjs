import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";

// Children stay in the verifier's process group. A parent interruption also
// disconnects IPC, which requests graceful cleanup in each fixture child.
export async function startFixture(configuration, cleanup) {
  const child = fork(new URL("./child.mjs", import.meta.url), [], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const observed = observeFixtureProcess(child);
  cleanup.push(observed.stop);
  child.send({ kind: "start", ...configuration });
  const ready = await observed.wait("ready");
  return { ...observed, origin: ready.origin, pid: ready.pid };
}

export function observeFixtureProcess(child) {
  const receipts = [];
  const waiters = new Set();
  let exited;
  let failure;
  let stderrBytes = 0;
  const stderrDigest = createHash("sha256");
  child.stderr.on("data", (bytes) => {
    stderrBytes += bytes.length;
    stderrDigest.update(bytes);
  });
  child.once("exit", (code, signal) => {
    exited = { code, signal };
    for (const waiter of waiters) waiter();
  });
  // `exit` joins the PID, but stdio can still deliver data. Only `close`
  // permits a final stderr digest and a successful cleanup receipt.
  const closed = new Promise((resolve) =>
    child.once("close", () => resolve(true)),
  );
  child.on("error", () => {
    failure = new Error("Capacity fixture child process failed");
    for (const waiter of waiters) waiter();
  });
  child.on("message", (message) => {
    receipts.push(message);
    if (message.kind === "fixture-error")
      failure = new Error("Capacity fixture reported an internal failure");
    for (const waiter of waiters) waiter();
  });
  function wait(kind, predicate = () => true, timeout = 10_000) {
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        waiters.delete(check);
        error ? reject(error) : resolve(value);
      };
      const check = () => {
        const receipt = receipts.find(
          (value) => value.kind === kind && predicate(value),
        );
        if (receipt) finish(undefined, receipt);
        else if (failure || exited)
          finish(
            failure ?? new Error(`Capacity fixture exited before ${kind}`),
          );
      };
      const timer = setTimeout(
        () => finish(new Error(`Capacity fixture did not report ${kind}`)),
        timeout,
      );
      waiters.add(check);
      check();
    });
  }
  let closing;
  async function stop() {
    if (closing) return closing;
    closing = (async () => {
      let forced = false;
      if (
        !exited &&
        child.connected &&
        !receipts.some((receipt) => receipt.kind === "stopped")
      )
        child.send({ kind: "stop" }, (error) => {
          // SIGTERM may already have closed IPC. The joined PID and stdio below
          // decide cleanup; a control-send race is not a process failure.
          if (
            error &&
            !["ERR_IPC_CHANNEL_CLOSED", "EPIPE"].includes(error.code)
          )
            failure = new Error("Capacity fixture stop request failed");
        });
      const join = async (ms) => {
        let timer;
        try {
          return await Promise.race([
            closed,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(undefined), ms);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      if (!(await join(4000))) {
        forced = true;
        child.kill("SIGTERM");
      }
      if (!(await join(2000))) child.kill("SIGKILL");
      if (!(await join(2000))) {
        child.stderr.destroy();
        throw new Error("capacity fixture child/stdio was not joined");
      }
      assert.equal(forced, false, "capacity fixture required forced shutdown");
      assert.deepEqual(exited, { code: 0, signal: null });
      assert.equal(
        stderrBytes,
        0,
        `capacity fixture stderr sha256=${stderrDigest.digest("hex")}`,
      );
      assert.equal(failure, undefined);
    })();
    return closing;
  }
  return { child, receipts, wait, stop };
}

// A ping brackets a child monotonic sample with independent client samples.
// Keep the offset interval; do not subtract unrelated performance.now origins.
export async function calibrate(fixture) {
  const samples = [];
  for (let index = 0; index < 6; index++) {
    const nonce = `${process.hrtime.bigint()}-${index}`;
    const before = process.hrtime.bigint();
    fixture.child.send({ kind: "ping", nonce });
    const reply = await fixture.wait("pong", (value) => value.nonce === nonce);
    const after = process.hrtime.bigint();
    const remote = BigInt(reply.ns);
    samples.push({
      before: before.toString(),
      remote: reply.ns,
      after: after.toString(),
      low: (remote - after).toString(),
      high: (remote - before).toString(),
    });
  }
  const low = samples.reduce(
    (value, sample) =>
      BigInt(sample.low) > value ? BigInt(sample.low) : value,
    BigInt(samples[0].low),
  );
  const high = samples.reduce(
    (value, sample) =>
      BigInt(sample.high) < value ? BigInt(sample.high) : value,
    BigInt(samples[0].high),
  );
  assert.ok(
    low <= high,
    "monotonic clock calibration intervals do not intersect",
  );
  return { low: low.toString(), high: high.toString(), samples };
}
