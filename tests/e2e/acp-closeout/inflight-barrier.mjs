import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { until } from "./wait.mjs";

export async function verifyInflightCheckpoint(request, project, invoke) {
  assert.match(project, /^antnest-stage3-e2e-[0-9]+$/);
  if (request.kind === "restart") {
    assert.deepEqual(Object.keys(request), ["kind"]);
    return request;
  }
  assert.deepEqual(Object.keys(request).sort(), [
    "agent_id",
    "kind",
    "version",
  ]);
  assert.equal(request.kind, "tool-inflight");
  assert.match(request.agent_id, /^agent_[a-f0-9]{32}$/);
  assert([1, 2].includes(request.version));
  const labels = {
    "io.antnest.runtime-controller-scope": project,
    "io.antnest.agent-id": request.agent_id,
    "io.antnest.managed": "runtime",
  };
  const container = (
    await invoke([
      "ps",
      "-q",
      "--no-trunc",
      ...Object.entries(labels).flatMap(([key, value]) => [
        "--filter",
        `label=${key}=${value}`,
      ]),
    ])
  ).trim();
  assert.match(container, /^[a-f0-9]{64}$/, "expected one test Runtime");
  const actual = JSON.parse(
    await invoke(["inspect", "--format", "{{json .Config.Labels}}", container]),
  );
  for (const [key, value] of Object.entries(labels))
    assert.equal(actual[key], value);
  const path = `/workspace/acp-unknown-v${request.version}`;
  // An in-progress database row can precede the physical write. Wait for the
  // file, but never treat a wrong/duplicated marker as a retryable barrier.
  const marker = await until(
    async () => {
      try {
        return await invoke(["exec", container, "cat", `${path}.log`]);
      } catch {
        return false;
      }
    },
    "physical in-flight marker",
    15000,
  );
  assert.equal(marker, `v${request.version}-tool-inflight\n`);
  const pid = (await invoke(["exec", container, "cat", `${path}.pid`])).trim();
  assert.match(pid, /^[1-9][0-9]*$/);
  assert(Number.isSafeInteger(Number(pid)));
  await invoke([
    "exec",
    container,
    "sh",
    "-c",
    'test ! -e "$1" && kill -0 "$2"',
    "--",
    `${path}.release`,
    pid,
  ]);
  return { ...request, container_id: container, tool_pid: Number(pid), marker };
}

export async function verifyRetiredRuntime(proof, invoke) {
  assert.equal(proof.kind, "tool-inflight");
  assert.match(proof.container_id, /^[a-f0-9]{64}$/);
  assert.equal(
    (
      await invoke([
        "ps",
        "-aq",
        "--no-trunc",
        "--filter",
        `id=${proof.container_id}`,
      ])
    ).trim(),
    "",
    "source Runtime still exists after rebuild",
  );
}

if (process.argv[1]?.endsWith("/inflight-barrier.mjs")) {
  const request = JSON.parse(await readFile(process.argv[2], "utf8"));
  const invoke = async (args) =>
    (
      await promisify(execFile)("docker", args, {
        timeout: 5000,
        maxBuffer: 65536,
      })
    ).stdout;
  if (process.argv[3] === "retired")
    await verifyRetiredRuntime(request, invoke);
  else
    process.stdout.write(
      JSON.stringify(
        await verifyInflightCheckpoint(
          request,
          process.env.COMPOSE_PROJECT_NAME,
          invoke,
        ),
      ) + "\n",
    );
}
