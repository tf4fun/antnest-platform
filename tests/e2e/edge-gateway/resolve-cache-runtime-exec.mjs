import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// The original Runtime's Node process owns the finite sampling command. Keep
// stdin open until exit: closing it cancels and joins the actual shell group,
// rather than merely killing the host's Docker attachment.
async function remoteProgram() {
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const { readdir, readFile } = await import("node:fs/promises");
  const { setTimeout: delay } = await import("node:timers/promises");
  const groupAlive = async (pgid) => {
    if (process.platform !== "linux") {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    }
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/u.test(name)) continue;
      let stat;
      try {
        stat = await readFile(`/proc/${name}/stat`, "utf8");
      } catch (error) {
        if (["ENOENT", "ESRCH"].includes(error.code)) continue;
        throw error;
      }
      const match = stat.match(/^\d+ \(.*\) ([A-Za-z]) \d+ (\d+) /u);
      if (!match) throw new Error("invalid process inventory");
      if (Number(match[2]) === pgid && match[1] !== "Z") return true;
    }
    return false;
  };
  const abort = new AbortController();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const cancel = () => abort.abort(new Error("Runtime sampling cancelled"));
  input.once("close", cancel);
  const timer = setTimeout(cancel, Number(process.argv[2]));
  let sent = false;
  let joined = true;
  const start = new Promise((resolve, reject) => {
    abort.signal.addEventListener("abort", () => reject(abort.signal.reason), {
      once: true,
    });
    input.on("line", (line) => {
      if (!sent && line === "execute") {
        sent = true;
        resolve();
      } else cancel();
    });
  });
  try {
    process.stdout.write(JSON.stringify({ kind: "ready" }) + "\n");
    await start;
    abort.signal.throwIfAborted();
    const output = await new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", process.argv[1]], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      joined = false;
      let output = "";
      let bytes = 0;
      let failure;
      const terminate = () => {
        failure ??= new Error("Runtime sampling cancelled");
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") failure = error;
        }
      };
      abort.signal.addEventListener("abort", terminate, { once: true });
      if (abort.signal.aborted) terminate();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (value) => {
        bytes += Buffer.byteLength(value);
        if (bytes > 1024 * 1024) terminate();
        else output += value;
      });
      child.stderr.on("data", (value) => {
        bytes += value.length;
        if (bytes > 1024 * 1024) terminate();
      });
      child.once("error", () => {
        failure = new Error("Runtime sampling could not start");
      });
      child.once("close", (code) => {
        const finish = async () => {
          if (child.pid && (await groupAlive(child.pid))) {
            failure ??= new Error("Runtime sampling left a live descendant");
            terminate();
            const deadline = performance.now() + 1000;
            while (await groupAlive(child.pid)) {
              if (performance.now() >= deadline)
                throw new Error("Runtime sampling group did not exit");
              await delay(10);
            }
          }
          joined = true;
          if (failure || code !== 0)
            throw failure ?? new Error("Runtime sampling command failed");
          return output;
        };
        finish()
          .then(resolve, reject)
          .finally(() => abort.signal.removeEventListener("abort", terminate));
      });
    });
    abort.signal.throwIfAborted();
    process.stdout.write(JSON.stringify({ kind: "result", output }) + "\n");
  } finally {
    clearTimeout(timer);
    input.off("close", cancel);
    input.close();
    process.stdin.destroy();
    process.stdout.write(JSON.stringify({ kind: "joined", joined }) + "\n");
  }
}

const program = `await (${remoteProgram.toString()})().catch(() => { process.stderr.write("Runtime sampling failed\\n"); process.exitCode = 1; });`;

export async function joinedRuntimeExec({
  args,
  environment = process.env,
  signal,
  timeoutMS = 15000,
  spawnProcess = spawn,
}) {
  assert.equal(args[0], "exec");
  assert.deepEqual(args.slice(-3, -1), ["sh", "-c"]);
  assert.match(args.at(-4), /^[a-f0-9]{64}$/u);
  assert(Number.isFinite(timeoutMS) && timeoutMS > 0);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      "docker",
      [
        "exec",
        "-i",
        ...args.slice(1, -3),
        "node",
        "--input-type=module",
        "-e",
        program,
        args.at(-1),
        String(Math.ceil(timeoutMS)),
      ],
      { env: environment, detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let ready = false;
    let result;
    let output = "";
    let bytes = 0;
    let failure;
    let fallback;
    let forced = false;
    let joined;
    const terminate = (reason) => {
      failure ??= reason;
      if (fallback) return;
      fallback = setTimeout(() => {
        forced = true;
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") failure = error;
        }
      }, 2000);
      if (!child.stdin.destroyed && !child.stdin.writableEnded)
        child.stdin.end("cancel\n");
    };
    const interrupt = () =>
      terminate(new Error("Runtime exec interrupted or timed out"));
    const timer = setTimeout(interrupt, timeoutMS);
    signal?.addEventListener("abort", interrupt, { once: true });
    if (signal?.aborted) interrupt();
    child.stdin.on("error", () =>
      terminate(new Error("Runtime exec handshake failed")),
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      bytes += Buffer.byteLength(data);
      if (bytes > 2 * 1024 * 1024)
        return terminate(new Error("Runtime exec output exceeded limit"));
      output += data;
      while (output.includes("\n")) {
        const at = output.indexOf("\n");
        const line = output.slice(0, at);
        output = output.slice(at + 1);
        try {
          const value = JSON.parse(line);
          if (value.kind === "ready") {
            assert.equal(ready, false);
            assert.deepEqual(value, { kind: "ready" });
            ready = true;
            if (!failure) child.stdin.write("execute\n");
          } else if (value.kind === "joined") {
            assert.equal(joined, undefined);
            assert.deepEqual(Object.keys(value).sort(), ["joined", "kind"]);
            assert.equal(typeof value.joined, "boolean");
            joined = value.joined;
          } else {
            assert(ready);
            assert.equal(result, undefined);
            assert.equal(value.kind, "result");
            assert.deepEqual(Object.keys(value).sort(), ["kind", "output"]);
            assert.equal(typeof value.output, "string");
            result = value.output;
          }
        } catch {
          terminate(new Error("Runtime exec receipt invalid"));
        }
      }
    });
    child.stderr.on("data", () =>
      terminate(new Error("Runtime exec reported failure")),
    );
    child.once("error", () => {
      failure ??= new Error("Runtime exec could not start");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(fallback);
      signal?.removeEventListener("abort", interrupt);
      if (
        !failure &&
        (code !== 0 || output !== "" || result === undefined || joined !== true)
      )
        failure = new Error("Runtime exec did not complete cleanly");
      if (failure) {
        // An unresponsive attachment cannot attest remote exit. The caller
        // must keep the failure and let the owning project cleanup finish.
        failure.remoteCleanupPending =
          joined !== true || forced || child.signalCode !== null;
        return reject(failure);
      }
      resolve(result.trim());
    });
  });
}
