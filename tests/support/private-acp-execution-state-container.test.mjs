import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrivateACPExecutionStateUnavailableError } from "./private-acp-execution-state-error.mjs";

const load = async (name) => {
  const url = new URL(name, import.meta.url);
  return import(url).catch((error) => {
    if (
      error.code !== "ERR_MODULE_NOT_FOUND" ||
      !error.message.includes(url.pathname)
    )
      throw error;
    return {};
  });
};
const implementation = await load(
  "./private-acp-execution-state-container.mjs",
);
const probe = await load("./private-acp-execution-state-probe.mjs");
const principal = {
  organization_id: "original-organization",
  user_id: "original-owner",
};
const accessToken = "PRIVATE-ORIGINAL-STATE-SESSION";
const image = "sha256:" + "a".repeat(64);
const ready = {
  agent_id: "agent_target",
  access_allowed: true,
  configuration_revision: "b".repeat(64),
  availability: "ready",
  active_session_id: null,
  unavailable_reason: null,
};
const rawBody = JSON.stringify(ready, null, 2) + "\n";

async function fixture(t, options = {}) {
  assert.equal(
    typeof implementation.readContainerPrivateExecutionState,
    "function",
  );
  assert.equal(typeof probe.probePrivateExecutionState, "function");
  const directory = await mkdtemp(join(tmpdir(), "antnest-state-container-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = {
    project: "antnest-lifecycle-1234abcd",
    credentials: join(directory, "credentials"),
    env: {
      ANTNEST_SERVICE_NETWORK_PREFIX: "172.30.12",
      ANTNEST_SERVICE_AUTH_UID: String(process.getuid()),
      ANTNEST_SERVICE_AUTH_GID: String(process.getgid()),
    },
  };
  const calls = [],
    cleanups = [];
  let inputPath,
    outputDirectory,
    live = false;
  const docker = async (args, _long, callOptions) => {
    calls.push(args);
    assert(callOptions.signal instanceof AbortSignal);
    if (args[0] === "ps") return "deployed-acp-container";
    if (args[0] === "inspect") return image;
    assert.equal(args[0], "run");
    live = true;
    inputPath = args
      .find((arg) => arg.endsWith(":/proof/input.json:ro"))
      .slice(0, -":/proof/input.json:ro".length);
    outputDirectory = args
      .find((arg) => arg.endsWith(":/proof/output"))
      .slice(0, -":/proof/output".length);
    assert.equal((await stat(inputPath)).mode & 0o777, 0o600);
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    assert.deepEqual(input.principal, principal);
    assert.equal(input.accessToken, accessToken);
    assert.equal(input.agentId, ready.agent_id);
    assert(input.timeoutMs > 0 && input.timeoutMs <= 15000);
    assert.equal(args.includes(image), true);
    assert.equal(JSON.stringify(args).includes(accessToken), false);
    assert.equal(args.includes("--read-only"), true);
    assert.equal(args.includes("no-new-privileges:true"), true);
    await probe.probePrivateExecutionState(input, {
      read: async (agentId, browser, context) => {
        assert.equal(agentId, ready.agent_id);
        assert.equal(browser.accessToken, accessToken);
        assert.deepEqual(context.principal, principal);
        assert(context.signal instanceof AbortSignal);
        const unavailable = options.unavailable;
        context.receipts.push({
          agentId,
          method: "POST",
          path: "/rpc/agent-acp/get-agent-execution-state",
          status: unavailable ? 503 : 200,
          rawBody: unavailable
            ? JSON.stringify({
                code: "execution_state_unavailable",
                message: "Agent execution state is unavailable",
                retryable: true,
              })
            : rawBody,
        });
        if (unavailable) throw new PrivateACPExecutionStateUnavailableError();
        return structuredClone(ready);
      },
      save: async (receipt) => {
        if (options.alter) options.alter(receipt);
        await writeFile(
          join(outputDirectory, "receipt.json"),
          JSON.stringify(receipt),
          { flag: "wx", mode: 0o600 },
        );
      },
    });
    if (options.runError) throw options.runError;
    return "";
  };
  const cleanupDocker = async (args) => {
    cleanups.push(args);
    if (options.cleanupError) throw options.cleanupError;
    if (args[0] === "ps") return live ? "owned-state-probe" : "";
    assert.deepEqual(args, ["rm", "-f", "owned-state-probe"]);
    live = false;
    return "owned-state-probe";
  };
  return {
    calls,
    cleanups,
    directory,
    config,
    read: (overrides = {}) =>
      implementation.readContainerPrivateExecutionState({
        config,
        docker,
        cleanupDocker,
        root: "/original/source",
        agentId: ready.agent_id,
        browser: { accessToken },
        principal,
        directory,
        ...overrides,
      }),
    async evidence() {
      return JSON.parse(
        await readFile(join(outputDirectory, "receipt.json"), "utf8"),
      );
    },
    async assertInputRemoved() {
      await assert.rejects(stat(inputPath), { code: "ENOENT" });
    },
    get live() {
      return live;
    },
  };
}

test("host state reader uses the deployed ACP image, original authority and exact private grants", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.read(), ready);
  const run = f.calls.find((args) => args[0] === "run");
  assert.deepEqual(
    run.flatMap((arg, index) => (arg === "--network" ? [run[index + 1]] : [])),
    [f.config.project + "_identity-clients", f.config.project + "_edge"],
  );
  const grants = run.filter((arg) => arg.includes(":/run/auth/"));
  assert.equal(grants.length, 2);
  assert(grants.some((arg) => arg.endsWith(":/run/auth/gateway-identity:ro")));
  assert(grants.some((arg) => arg.endsWith(":/run/auth/agent-ui-acp:ro")));
  assert(run.includes("--add-host=identity-service:172.30.12.66"));
  assert(run.includes("--add-host=agent-acp-service:172.30.12.5"));
  const evidence = await f.evidence();
  assert.equal(evidence.receipts.length, 1);
  assert.equal(evidence.receipts[0].rawBody, rawBody);
  assert.equal(JSON.stringify(evidence).includes(accessToken), false);
  await f.assertInputRemoved();
  assert.equal(f.live, false);
});

test("exact startup unavailability remains typed after its complete private receipt is saved", async (t) => {
  const f = await fixture(t, { unavailable: true });
  await assert.rejects(f.read(), PrivateACPExecutionStateUnavailableError);
  const receipt = await f.evidence();
  assert.equal(receipt.outcome, "unavailable");
  assert.equal(receipt.receipts[0].status, 503);
  await f.assertInputRemoved();
  assert.equal(f.live, false);
});

test("a Docker failure cannot be converted to success by an already written state response", async (t) => {
  const failure = new Error("container command failed after archive");
  const f = await fixture(t, { runError: failure });
  await assert.rejects(f.read(), (error) => error === failure);
  assert.equal((await f.evidence()).receipts[0].rawBody, rawBody);
  await f.assertInputRemoved();
  assert.equal(f.live, false);
});

test("host preserves command and cleanup failures and still deletes the secret input", async (t) => {
  const failure = new Error("container command failed"),
    cleanup = new Error("container cleanup failed");
  const f = await fixture(t, { runError: failure, cleanupError: cleanup });
  await assert.rejects(f.read(), (error) => {
    assert.deepEqual(error.errors, [failure, cleanup]);
    return true;
  });
  await f.assertInputRemoved();
});

test("a successful envelope cannot substitute a different Agent or configuration state", async (t) => {
  const f = await fixture(t, {
    alter: (receipt) => {
      receipt.state.configuration_revision = "c".repeat(64);
    },
  });
  await assert.rejects(f.read());
  assert.equal((await f.evidence()).receipts[0].rawBody, rawBody);
  await f.assertInputRemoved();
  assert.equal(f.live, false);
});

test("an already cancelled state read creates no credentials or containers", async (t) => {
  const f = await fixture(t),
    reason = new Error("cancelled before state read");
  await assert.rejects(
    f.read({ signal: AbortSignal.abort(reason) }),
    (error) => error === reason,
  );
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.cleanups, []);
  assert.deepEqual(await readdir(f.directory), []);
});

test("probe attempts the raw archive after failure and preserves simultaneous archive failure", async () => {
  assert.equal(typeof probe.probePrivateExecutionState, "function");
  const failure = new Error("private state failed"),
    archive = new Error("private archive failed");
  let archived;
  await assert.rejects(
    probe.probePrivateExecutionState(
      {
        agentId: ready.agent_id,
        accessToken,
        principal,
        timeoutMs: 15000,
      },
      {
        read: async (_agent, _browser, { receipts }) => {
          receipts.push({ status: 503, rawBody: "original failure bytes" });
          throw failure;
        },
        save: async (value) => {
          archived = value;
          throw archive;
        },
      },
    ),
    (error) => {
      assert.deepEqual(error.errors, [failure, archive]);
      return true;
    },
  );
  assert.equal(archived.receipts[0].rawBody, "original failure bytes");
  assert.equal(archived.outcome, "failed");
});
