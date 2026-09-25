import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(
  new URL("../../../services/agent-ui/web/", import.meta.url),
);

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

test(
  "development entry serves the full Node workspace API",
  { timeout: 90_000 },
  async () => {
    const port = await unusedPort();
    const child = spawn("npm", ["run", "dev"], {
      cwd: web,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ANTNEST_AGENT_ACP_SERVICE_URL: "http://127.0.0.1:1",
        ANTNEST_AGENT_UI_BRIDGE_HOST: "127.0.0.1",
        ANTNEST_AGENT_UI_BRIDGE_PORT: String(port),
        OTEL_SDK_DISABLED: "true",
      },
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      let ready = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        if (child.exitCode !== null) break;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/status`, {
            signal: AbortSignal.timeout(500),
          });
          if (response.status === 200) {
            ready = true;
            break;
          }
        } catch {}
        await delay(250);
      }
      assert.ok(ready, `Development Bridge did not become ready:\n${output}`);
      const response = await fetch(`http://127.0.0.1:${port}/workspace/`);
      assert.equal(
        response.status,
        401,
        "Development HTML must use Bridge authentication",
      );
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      stop();
      await Promise.race([closed, delay(3_000)]);
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        await closed;
      }
    }
  },
);
