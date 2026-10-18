import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerClient } from "../e2e/lifecycle-closeout/docker.mjs";
import { grantContainerArgs } from "./service-grants.mjs";
import { durablePath } from "./storage.mjs";
import { PrivateACPExecutionStateUnavailableError } from "./private-acp-execution-state-error.mjs";

const unavailable = {
  code: "execution_state_unavailable",
  message: "Agent execution state is unavailable",
  retryable: true,
};
const words = (value) => value.trim().split(/\s+/u).filter(Boolean);

export async function readContainerPrivateExecutionState({
  config,
  agentId,
  browser,
  principal,
  signal,
  timeoutMs = 15000,
  root = fileURLToPath(new URL("../../", import.meta.url)),
  directory = join(
    root,
    "artifacts/verification/authenticated-e2e",
    config.project,
    "execution-state",
  ),
  docker = dockerClient(config.env, signal, 30000),
  cleanupDocker,
}) {
  signal?.throwIfAborted();
  assert.match(config.project, /^[a-z0-9][a-z0-9_-]+$/u);
  assert(typeof agentId === "string" && agentId.length > 0);
  assert(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 15000,
  );
  const accessToken = browser.accessToken;
  assert(
    typeof accessToken === "string" && accessToken.length > 0,
    "original browser session required",
  );
  const originalPrincipal = {};
  for (const field of ["organization_id", "user_id"]) {
    assert(
      typeof principal?.[field] === "string" && principal[field].length > 0,
      "original browser Principal required",
    );
    originalPrincipal[field] = principal[field];
  }
  const deadline = Date.now() + timeoutMs;
  const active = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(timeoutMs),
  ]);
  const options = () => {
    active.throwIfAborted();
    return { signal: active, timeoutMS: Math.max(1, deadline - Date.now()) };
  };
  const granted = grantContainerArgs(config, [
    "gateway-identity",
    "agent-ui-acp",
  ]);
  directory = durablePath(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const owned = await mkdtemp(join(directory, "read-"));
  const output = join(owned, "output"),
    input = join(owned, "input.json");
  const label = "io.antnest.e2e.state-read=" + randomUUID();
  const errors = [];
  let attempted = false,
    state;
  try {
    await mkdir(output, { mode: 0o700 });
    const ids = words(
      await docker(
        [
          "ps",
          "-aq",
          "--filter",
          "label=com.docker.compose.project=" + config.project,
          "--filter",
          "label=com.docker.compose.service=agent-acp-service",
        ],
        false,
        options(),
      ),
    );
    assert.equal(ids.length, 1, "expected one deployed ACP service");
    const image = (
      await docker(
        ["inspect", "--format", "{{.Image}}", ids[0]],
        false,
        options(),
      )
    ).trim();
    assert.match(image, /^sha256:[a-f0-9]{64}$/u);
    await writeFile(
      input,
      JSON.stringify({
        agentId,
        accessToken,
        principal: originalPrincipal,
        timeoutMs: Math.max(1, deadline - Date.now()),
      }),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(owned, "invocation.json"),
      JSON.stringify({ agentId, project: config.project, image }),
      { flag: "wx", mode: 0o600 },
    );
    attempted = true;
    await docker(
      [
        "run",
        "--rm",
        "--pull",
        "never",
        "--label",
        "com.docker.compose.project=" + config.project,
        "--label",
        label,
        ...granted.networks.flatMap((network) => [
          "--network",
          config.project + "_" + network,
        ]),
        ...granted.args,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "-v",
        join(root, "tests") + ":/app/tests:ro",
        "-v",
        join(root, "contracts/agent-acp/agent-execution-state.schema.json") +
          ":/app/contracts/agent-acp/agent-execution-state.schema.json:ro",
        "-v",
        input + ":/proof/input.json:ro",
        "-v",
        output + ":/proof/output",
        image,
        "node",
        "/app/tests/support/private-acp-execution-state-probe.mjs",
        "/proof/input.json",
        "/proof/output/receipt.json",
      ],
      false,
      options(),
    );
    active.throwIfAborted();
    const receipt = JSON.parse(
      await readFile(join(output, "receipt.json"), "utf8"),
    );
    assert.equal(receipt.version, 1);
    assert.equal(receipt.agentId, agentId);
    assert(Array.isArray(receipt.receipts));
    if (receipt.outcome === "failed")
      throw new Error("Private ACP state probe failed; see private receipt", {
        cause: receipt.error,
      });
    const response = receipt.receipts.at(-1);
    assert.equal(response?.agentId, agentId);
    assert.equal(response.method, "POST");
    assert.equal(response.path, "/rpc/agent-acp/get-agent-execution-state");
    if (receipt.outcome === "unavailable") {
      assert.equal(response.status, 503);
      assert.deepEqual(JSON.parse(response.rawBody), unavailable);
      throw new PrivateACPExecutionStateUnavailableError();
    }
    assert.equal(receipt.outcome, "passed");
    assert.equal(response.status, 200);
    assert.equal(receipt.state?.agent_id, agentId);
    assert.deepEqual(
      receipt.state,
      JSON.parse(response.rawBody),
      "private state differs from the complete original response",
    );
    state = receipt.state;
  } catch (error) {
    errors.push(error);
  }
  if (attempted) {
    try {
      // Cleanup has its own bounded lifetime even when the caller was aborted.
      const clean = cleanupDocker ?? dockerClient(config.env, undefined, 30000);
      const ids = words(
        await clean(["ps", "-aq", "--filter", "label=" + label]),
      );
      assert(ids.length <= 1, "state probe ownership is ambiguous");
      if (ids.length) await clean(["rm", "-f", ids[0]]);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await rm(input, { force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, "Private state probe and cleanup failed");
  return state;
}
