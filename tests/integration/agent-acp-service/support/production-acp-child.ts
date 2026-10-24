import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { within } from "./production-peers.js";

const servicePackage = new URL(
  "../../../../services/agent-acp-service/package.json",
  import.meta.url,
);
type Exit = { code: number | null; signal: NodeJS.Signals | null };

/** Runs the actual main entrypoint; no replacement loader, IPC or application shim. */
export class ProductionAcpChild {
  private readonly child: ChildProcess;
  private readonly exited = Promise.withResolvers<Exit>();
  private readonly closed = Promise.withResolvers<Exit>();
  private exit: Exit | undefined;
  private error: Error | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly events: string[] = [];

  public constructor(
    environment: NodeJS.ProcessEnv,
    private readonly origin: string,
  ) {
    this.child = spawn(
      process.execPath,
      [
        "--import",
        createRequire(servicePackage).resolve("tsx"),
        fileURLToPath(new URL("./src/main.ts", servicePackage)),
      ],
      {
        cwd: fileURLToPath(new URL(".", servicePackage)),
        env: {
          ...environment,
          TSX_TSCONFIG_PATH: fileURLToPath(
            new URL("./run-intent-child.tsconfig.json", import.meta.url),
          ),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child.once("error", (error) => {
      this.error = error;
    });
    this.child.once("exit", (code, signal) => {
      this.exit = { code, signal };
      this.exited.resolve(this.exit);
    });
    this.child.once("close", (code, signal) =>
      this.closed.resolve({ code, signal }),
    );
    for (const stream of [this.child.stdout, this.child.stderr]) {
      let partial = "";
      stream?.on("data", (chunk: Buffer) => {
        partial += chunk.toString("utf8");
        let newline: number;
        while ((newline = partial.indexOf("\n")) >= 0) {
          const line = partial.slice(0, newline);
          partial = partial.slice(newline + 1);
          try {
            const value = JSON.parse(line) as {
              event?: unknown;
              error_type?: unknown;
            };
            if (typeof value.event === "string")
              this.events.push(
                value.event +
                  (typeof value.error_type === "string"
                    ? ":" + value.error_type
                    : ""),
              );
            if (this.events.length > 30) this.events.shift();
          } catch {
            /* Raw child output may contain credentials; retain event names only. */
          }
        }
        partial = partial.slice(-8192);
      });
    }
  }

  public async ready(): Promise<void> {
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      if (this.error !== undefined) throw this.error;
      if (this.exit !== undefined)
        throw new Error(
          `ACP main exited before readiness: ${JSON.stringify(this.exit)}; ${this.events.join(",")}`,
        );
      try {
        const response = await fetch(this.origin + "/status", {
          signal: AbortSignal.timeout(500),
        });
        await response.arrayBuffer();
        if (response.status === 200) return;
      } catch {
        /* Observe readiness again while the original child is alive. */
      }
      await delay(25);
    }
    throw new Error("ACP main did not become ready; " + this.events.join(","));
  }

  public stop(): Promise<void> {
    this.stopPromise ??= this.stopOriginal();
    return this.stopPromise;
  }

  private async stopOriginal(): Promise<void> {
    this.child.kill("SIGTERM");
    let forced = false;
    let result: Exit;
    try {
      result = await within(
        this.closed.promise,
        "original ACP child close",
        10_000,
      );
    } catch {
      forced = true;
      this.child.kill("SIGKILL");
      result = await this.closed.promise;
    }
    if (this.error !== undefined) throw this.error;
    const exit = await this.exited.promise;
    if (
      forced ||
      result.code !== 0 ||
      result.signal !== null ||
      exit.code !== result.code ||
      exit.signal !== result.signal
    )
      throw new Error(
        `ACP did not shut down cleanly: ${JSON.stringify({ forced, exit, close: result })}; ${this.events.join(",")}`,
      );
  }
}
