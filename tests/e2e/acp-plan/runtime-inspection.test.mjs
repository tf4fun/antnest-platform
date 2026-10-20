import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
const url = new URL("./runtime-inspection.mjs", import.meta.url);
const implementation = await import(url).catch((error) => {
  if (
    error.code !== "ERR_MODULE_NOT_FOUND" ||
    !error.message.includes(url.pathname)
  )
    throw error;
  return {};
});
const entry = (name) => {
  assert.equal(typeof implementation[name], "function", name);
  return implementation[name];
};
const project = "antnest-stage3-e2e-1234",
  runID = "2485d43c-9cb0-42a0-9c9f-186a2dc3e855";
const image = `antnest/antnest-runtime:plan-${runID}`;
const env = {
  COMPOSE_PROJECT_NAME: project,
  ANTNEST_E2E_RUN_ID: runID,
  TEST_RUNTIME_IMAGE: image,
};
const agents = ["agent-one", "agent-two"];
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "antnest-plan-runtime-"));
  const controller = new AbortController(),
    pending = [];
  const signal = AbortSignal.any([controller.signal, t.signal]);
  t.after(async () => {
    controller.abort(new Error("Runtime inspection test finished"));
    await Promise.allSettled(pending);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    options: { env, directory, wait: turn, signal },
    track(promise) {
      pending.push(promise);
      promise.catch(() => {});
      return promise;
    },
  };
}
const proof = () => ({
  raw_sha256: "a".repeat(64),
  runtimes: agents.map((agent_id, index) => ({
    project,
    agent_id,
    generation: 1,
    container_id: String(index + 1).repeat(64),
    image_id: "sha256:" + "4".repeat(64),
    image_ref: image,
  })),
});
test("client waits for the host inspection of both live Agent Runtimes before cleanup can proceed", async (t) => {
  const request = entry("requestPlanRuntimeInspection"),
    serve = entry("servePlanRuntimeInspection"),
    f = await fixture(t);
  const started = Promise.withResolvers(),
    release = Promise.withResolvers();
  let clientSettled = false;
  const client = f.track(request(agents, f.options));
  client.then(
    () => {
      clientSettled = true;
    },
    () => {
      clientSettled = true;
    },
  );
  const host = f.track(
    serve({
      ...f.options,
      inspect: async (message) => {
        assert.deepEqual(message.agent_ids, agents);
        assert.equal(message.runtime_image, image);
        assert.equal(
          JSON.parse(
            await readFile(join(f.directory, "runtime-request.json"), "utf8"),
          ).nonce,
          message.nonce,
        );
        started.resolve();
        await release.promise;
        return proof();
      },
    }),
  );
  try {
    await Promise.race([
      started.promise,
      client.then(() => assert.fail("client completed before inspection")),
      host.then(() => assert.fail("host completed before inspection")),
    ]);
    await turn();
    assert.equal(clientSettled, false);
  } finally {
    release.resolve();
  }
  const [checked, receipt] = await Promise.all([client, host]);
  assert.deepEqual(checked, receipt);
  assert.deepEqual(
    checked.runtimes.map((item) => item.agent_id),
    agents,
  );
  assert.equal(checked.status, "verified");
  assert.deepEqual((await readdir(f.directory)).sort(), [
    "runtime-receipt.json",
    "runtime-request.json",
  ]);
});
for (const [label, mutate] of [
  [
    "stale nonce",
    (value) => {
      value.request.nonce = runID;
    },
  ],
  [
    "wrong project",
    (value) => {
      value.request.project = "foreign";
    },
  ],
  [
    "foreign Agent",
    (value) => {
      value.runtimes[1].agent_id = "other";
    },
  ],
  [
    "repeated container",
    (value) => {
      value.runtimes[1].container_id = value.runtimes[0].container_id;
    },
  ],
  [
    "stale Runtime image",
    (value) => {
      value.runtimes[0].image_ref = "antnest/antnest-runtime:local";
    },
  ],
  [
    "different image ID",
    (value) => {
      value.runtimes[1].image_id = "sha256:" + "5".repeat(64);
    },
  ],
  [
    "invalid generation",
    (value) => {
      value.runtimes[0].generation = 0;
    },
  ],
  [
    "missing raw evidence hash",
    (value) => {
      delete value.raw_sha256;
    },
  ],
])
  test("client refuses an unrelated host receipt: " + label, async (t) => {
    const request = entry("requestPlanRuntimeInspection"),
      f = await fixture(t);
    let written = false;
    await assert.rejects(
      request(agents, {
        ...f.options,
        wait: async () => {
          if (written) return;
          const message = JSON.parse(
            await readFile(join(f.directory, "runtime-request.json"), "utf8"),
          );
          const result = { request: message, status: "verified", ...proof() };
          mutate(result);
          written = true;
          await writeFile(
            join(f.directory, "runtime-receipt.json"),
            JSON.stringify(result),
          );
        },
      }),
    );
    assert(written);
  });
test("a cancelled host inspection joins its callback and cannot publish an acknowledgement", async (t) => {
  const request = entry("requestPlanRuntimeInspection"),
    serve = entry("servePlanRuntimeInspection"),
    f = await fixture(t);
  const controller = new AbortController(),
    failure = new Error("stop runtime inspection");
  const signal = AbortSignal.any([f.options.signal, controller.signal]);
  const client = f.track(request(agents, { ...f.options, signal }));
  await assert.rejects(
    f.track(
      serve({
        ...f.options,
        signal,
        inspect: async () => {
          await turn();
          controller.abort(failure);
          return proof();
        },
      }),
    ),
    (error) => error === failure,
  );
  await assert.rejects(client, (error) => error === failure);
  assert.deepEqual(await readdir(f.directory), ["runtime-request.json"]);
});
test("an inspection failure retains its request but never allows client cleanup to continue", async (t) => {
  const request = entry("requestPlanRuntimeInspection"),
    serve = entry("servePlanRuntimeInspection"),
    f = await fixture(t);
  const controller = new AbortController();
  const signal = AbortSignal.any([f.options.signal, controller.signal]);
  const client = f.track(request(agents, { ...f.options, signal }));
  try {
    await assert.rejects(
      f.track(
        serve({
          ...f.options,
          inspect: async () => {
            throw new Error("wrong actual Runtime image");
          },
        }),
      ),
      /wrong actual Runtime image/,
    );
    assert.deepEqual(await readdir(f.directory), ["runtime-request.json"]);
  } finally {
    controller.abort();
  }
  await assert.rejects(client);
});
