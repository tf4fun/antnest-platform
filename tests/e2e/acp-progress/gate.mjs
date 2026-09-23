import assert from "node:assert/strict";
import { request } from "node:http";

// Test-only Docker access: never exposed by a product service. Every operation
// is constrained to one Agent container owned by this disposable Compose scope.
function docker(path, body, expected = 200, json = true) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: "/var/run/docker.sock",
        path,
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json" },
      },
      async (response) => {
        try {
          assert.equal(
            response.statusCode,
            expected,
            `gate Docker status: ${response.statusCode}`,
          );
          const chunks = [];
          let size = 0;
          for await (const chunk of response) {
            size += chunk.length;
            assert(size < 1024 * 1024, "gate response too large");
            chunks.push(chunk);
          }
          resolve(
            json ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
          );
        } catch (error) {
          reject(error);
        }
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("gate Docker deadline")),
      10000,
    );
    req.once("error", reject);
    req.once("close", () => clearTimeout(timer));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export async function runtimeGate(agent) {
  assert.match(agent, /^agent_[a-f0-9]+$/);
  const container = `antnest-runtime-${agent}`;
  const info = await docker(`/containers/${container}/json`);
  assert(process.env.COMPOSE_PROJECT_NAME);
  assert.equal(
    info.Config.Labels["io.antnest.runtime-controller-scope"],
    process.env.COMPOSE_PROJECT_NAME,
  );
  assert.equal(info.Config.Labels["io.antnest.agent-id"], agent);
  const execute = async (phase, command) => {
    assert.match(phase, /^v[12]-(bash|managed)-(success|failure|cancel)$/);
    const exec = await docker(
      `/containers/${info.Id}/exec`,
      {
        User: "1000:1000",
        AttachStdout: true,
        AttachStderr: true,
        Cmd: ["/bin/sh", "-c", command],
      },
      201,
    );
    await docker(
      `/exec/${exec.Id}/start`,
      { Detach: false, Tty: false },
      200,
      false,
    );
    const result = await docker(`/exec/${exec.Id}/json`);
    assert.equal(result.Running, false);
    return result.ExitCode;
  };
  const pid = (phase) =>
    `pid=$(cat /workspace/${phase}-pid) || exit 2; case "$pid" in ''|*[!0-9]*) exit 2;; esac; [ "$pid" -gt 1 ] || exit 2;`;
  return {
    release: async (phase) =>
      assert.equal(
        await execute(phase, `touch /workspace/${phase}-release`),
        0,
      ),
    alive: async (phase, source) => {
      const command =
        source === "bash"
          ? `${pid(phase)} kill -0 "$pid"`
          : `test -s /workspace/${phase}-started && test ! -e /workspace/${phase}-canceled`;
      assert.equal(
        await execute(phase, command),
        0,
        "execution was not alive before cancel",
      );
    },
    stopped: async (phase, source) => {
      const command =
        source === "bash"
          ? `${pid(phase)} ! kill -0 "$pid" 2>/dev/null`
          : `test -s /workspace/${phase}-canceled`;
      const code = await execute(phase, command);
      assert(code === 0 || code === 1, "invalid cancellation probe");
      return code === 0;
    },
  };
}
