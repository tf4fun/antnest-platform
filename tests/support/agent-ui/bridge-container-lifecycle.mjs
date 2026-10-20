import { spawn } from "node:child_process";
import { get } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

// Lifecycle operations used only by the Agent UI production-container gate.
export async function runJoined(
  command,
  args,
  { signal, cwd, env, timeout = 180_000, maxBuffer = 2_000_000 } = {},
) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [],
      stderr = [];
    let bytes = 0,
      failure,
      killTimer;
    const kill = (name) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if (error.code !== "ESRCH") failure ??= error;
      }
    };
    const stop = (error) => {
      failure ??= error;
      if (killTimer) return;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2000);
    };
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBuffer)
        stop(new Error("Bridge container command output exceeded its budget"));
      else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    const abort = () => stop(signal.reason);
    const interrupted = () =>
      stop(new Error("Bridge container command interrupted"));
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => stop(new Error("Bridge container command timed out")),
      timeout,
    );
    child.once("error", (error) => {
      failure ??= error;
    });
    const groupExists = () => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        // Permission denial is not proof of absence. In particular a group
        // may briefly be unsignalable while its last member is being reaped.
        // Keep the same deadline and require ESRCH before declaring it joined.
        if (error.code === "EPERM") return true;
        throw error;
      }
    };
    child.once("close", async (code, exitSignal) => {
      // Descendants with independent stdio can outlive the direct child. Keep
      // the TERM-to-KILL timer until the entire owned process group disappears.
      try {
        if (groupExists()) {
          stop(new Error("Bridge container command left a running descendant"));
          const deadline = Date.now() + 5000;
          while (groupExists()) {
            if (Date.now() >= deadline) {
              kill("SIGKILL");
              throw new Error(
                "Bridge container command process group did not exit",
              );
            }
            await delay(10);
          }
        }
      } catch (error) {
        failure = failure
          ? new AggregateError(
              [failure, error],
              "Bridge command cleanup failed",
              { cause: failure },
            )
          : error;
      }
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      process.off("SIGINT", interrupted);
      process.off("SIGTERM", interrupted);
      if (failure || code !== 0) {
        reject(
          failure ??
            new Error(
              `Bridge container command failed (${code ?? exitSignal})`,
            ),
        );
      } else
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
    if (signal?.aborted) abort();
  });
}

export function ownFixtureServer(server, signal) {
  const sockets = new Set();
  const listening = new AbortController();
  let closing;
  const connection = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  server.on("connection", connection);
  const close = () => {
    signal?.removeEventListener("abort", abort);
    closing ??= new Promise((resolve, reject) => {
      listening.abort();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      server.close((error) => {
        server.off("connection", connection);
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
    });
    return closing;
  };
  const abort = () => {
    void close().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  return {
    server,
    listen: async (port = 0, host = "0.0.0.0") => {
      signal?.throwIfAborted();
      listening.signal.throwIfAborted();
      try {
        await new Promise((resolve, reject) => {
          const finish = (error) => {
            server.off("error", failed);
            server.off("listening", ready);
            signal?.removeEventListener("abort", cancelled);
            if (error) reject(error);
            else resolve();
          };
          const failed = (error) => finish(error);
          const ready = () => finish();
          const cancelled = () => finish(signal.reason);
          server.once("error", failed);
          server.once("listening", ready);
          signal?.addEventListener("abort", cancelled, { once: true });
          try {
            server.listen({ port, host, signal: listening.signal });
          } catch (error) {
            finish(error);
          }
        });
        signal?.throwIfAborted();
      } catch (error) {
        await close();
        throw error;
      }
    },
    close,
  };
}

export async function finishBridgeCase({ body, diagnostics, cleanup }) {
  const errors = [];
  let value;
  const attempt = async (action) => {
    try {
      await action();
    } catch (error) {
      if (!errors.includes(error)) errors.push(error);
    }
  };
  try {
    value = await body();
  } catch (error) {
    errors.push(error);
    await attempt(() => diagnostics?.(error));
  }
  for (const action of cleanup) await attempt(action);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Bridge container case failed", {
      cause: errors[0],
    });
  return value;
}

export const bridgeOwnerLabel = "dev.antnest.agent-ui-bridge-verification";

export async function removeBridgeDocker(docker, { containers, image, owner }) {
  const resources = [
    ...containers.map((name) => ({
      name,
      kind: "container",
      probe: [
        "container",
        "ls",
        "-aq",
        "--filter",
        `name=^/${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`,
      ],
      remove: ["rm", "-f", name],
    })),
    {
      name: image,
      kind: "image",
      probe: ["image", "ls", "-q", "--filter", `reference=${image}`],
      remove: ["image", "rm", image],
    },
  ];
  const exists = async (resource) =>
    (await docker(resource.probe, 30_000)).stdout.trim() !== "";
  const errors = [];
  for (const resource of resources) {
    try {
      if (!(await exists(resource))) continue;
      const label = (
        await docker(
          [
            resource.kind,
            "inspect",
            "--format",
            `{{ index .Config.Labels "${bridgeOwnerLabel}" }}`,
            resource.name,
          ],
          30_000,
        )
      ).stdout.trim();
      if (label !== owner)
        throw new Error(`Bridge fixture ownership changed: ${resource.name}`);
      await docker(resource.remove, 30_000);
    } catch (error) {
      errors.push(error);
    }
  }
  for (const resource of resources) {
    try {
      if (await exists(resource))
        throw new Error(`Bridge fixture resource remains: ${resource.name}`);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Bridge Docker cleanup failed", {
      cause: errors[0],
    });
}

export async function openPausedResponse(url, { headers, signal, onFailure }) {
  signal?.throwIfAborted();
  const request = get(url, { headers, signal });
  const closed = new Promise((resolve) => request.once("close", resolve));
  let response;
  const close = async () => {
    response?.destroy();
    request.destroy();
    await closed;
  };
  try {
    response = await new Promise((resolve, reject) => {
      request.once("response", (value) => {
        value.on("error", (error) => {
          if (!signal?.aborted) onFailure?.(error);
        });
        resolve(value);
      });
      request.once("error", (error) =>
        reject(signal?.aborted ? signal.reason : error),
      );
    });
    response.pause();
    return { response, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export function startBridgePump(reader, consume, onFailure) {
  let stopping = false,
    closing;
  const done = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        if (stopping) return false;
        throw new Error("Bridge SSE closed before its expected watermark");
      }
      if (consume(next.value)) return true;
    }
  })().catch((error) => {
    if (!stopping) onFailure?.(error);
    throw error;
  });
  void done.catch(() => {});
  return {
    done,
    stop: () => {
      stopping = true;
      closing ??= finishBridgeCase({
        body: async () => {
          await reader.cancel();
        },
        cleanup: [
          async () => {
            await done;
          },
          async () => {
            reader.releaseLock();
          },
        ],
      });
      return closing;
    },
  };
}
