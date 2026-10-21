import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cases } from "./model.mjs";
import {
  fileStateFixture,
  fileCheckpointFixtures,
  fileByteReceiptFixtures,
} from "./file-state.fixture.mjs";

const url = new URL("./file-state.mjs", import.meta.url);
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
const runtimes = ["agent-one", "agent-two"].map((agent_id, index) => ({
  agent_id,
  container_id: String(index + 1).repeat(64),
  generation: index + 1,
  image_id: "sha256:" + "4".repeat(64),
  image_ref: "antnest/antnest-runtime:files-fixture",
  project: "antnest-stage3-e2e-1234",
}));
const content = () =>
  Buffer.from(cases.find((item) => item.id === "read").result.content);
const diagnosticCases = [
  [
    "missing Trace and Span",
    (rows) => {
      for (const row of rows) {
        row.trace_id = undefined;
        row.model_span_id = undefined;
      }
    },
  ],
  [
    "malformed Trace and Span",
    (rows) => {
      for (const [index, row] of rows.entries()) {
        row.trace_id = index % 2 ? "invalid-final-trace" : "invalid-tool-trace";
        row.model_span_id = "invalid-span";
      }
    },
  ],
  [
    "reused and unrelated Trace and Span",
    (rows) => {
      for (const row of rows) {
        row.trace_id = "a".repeat(32);
        row.model_span_id = "b".repeat(16);
      }
      rows[0].trace_id = "c".repeat(32);
    },
  ],
];

test("final byte checkpoints bind each real complete read and failed edit to the owning Agent and ordered model inventory", () => {
  const f = fileStateFixture();
  assert.deepEqual(
    entry("fileStateExpectations")(f.agents, f.requests, f.executions),
    fileCheckpointFixtures(),
  );
});
for (const [label, mutate] of diagnosticCases) {
  test(`file expectations accept ${label} without changing business facts or fabricating identifiers`, () => {
    const f = fileStateFixture();
    mutate(f.requests);
    const before = structuredClone(f),
      expected = fileCheckpointFixtures();
    for (const file of expected)
      for (const name of ["read", "failed_edit"]) {
        const original = f.requests.find(
          (row) => row.phase === file[name].phase && row.stage === "final",
        );
        file[name].trace_id = original.trace_id;
        file[name].model_span_id = original.model_span_id;
      }
    assert.deepEqual(
      entry("fileStateExpectations")(f.agents, f.requests, f.executions),
      expected,
    );
    assert.deepEqual(
      f,
      before,
      "original model and execution receipts changed",
    );
  });

  test(`host checkpoints accept ${label} and retain exact file and Runtime byte receipts`, () => {
    const files = fileCheckpointFixtures();
    mutate(files.flatMap((file) => [file.read, file.failed_edit]));
    const before = structuredClone(files),
      agents = runtimes.map((runtime) => runtime.agent_id),
      inspect = entry("inspectFileCheckpoints");
    assert.strictEqual(inspect(files, agents), files);
    assert.deepEqual(
      files,
      before,
      "host checkpoint diagnostics were rewritten",
    );
    const receipts = fileByteReceiptFixtures(runtimes);
    for (const [index, file] of files.entries())
      for (const name of ["read", "failed_edit"]) {
        receipts[index][name].trace_id = file[name].trace_id;
        receipts[index][name].model_span_id = file[name].model_span_id;
      }
    const originalReceipts = structuredClone(receipts);
    assert.strictEqual(
      entry("inspectFinalFileReceipts")(receipts, files, runtimes),
      receipts,
    );
    assert.deepEqual(receipts, originalReceipts);
    if (label === "missing Trace and Span") {
      // Undefined diagnostics disappear across the real JSON checkpoint IPC.
      const wire = JSON.parse(JSON.stringify(files)),
        originalWire = structuredClone(wire);
      for (const file of wire)
        for (const name of ["read", "failed_edit"]) {
          assert.equal(Object.hasOwn(file[name], "trace_id"), false);
          assert.equal(Object.hasOwn(file[name], "model_span_id"), false);
        }
      assert.strictEqual(inspect(wire, agents), wire);
      assert.deepEqual(wire, originalWire);
    }
  });
}
for (const [label, mutate] of [
  [
    "different live Tool ID",
    (f) => {
      f.executions[2].toolCallId = "a".repeat(64);
    },
  ],
  [
    "unnormalized provider ID",
    (f) => {
      f.executions[2].toolCallId = "v1-read";
      f.requests[5].tool_result.tool_call_id = "v1-read";
    },
  ],
  [
    "same Tool ID reused across Runs",
    (f) => {
      f.executions[2].toolCallId = f.executions[1].toolCallId;
      f.requests[5].tool_result.tool_call_id = f.executions[1].toolCallId;
    },
  ],
  ["missing model request", (f) => f.requests.pop()],
  ["reordered model requests", (f) => f.requests.reverse()],
  [
    "foreign original tool ID",
    (f) => {
      f.requests[5].tool_result.tool_call_id = "v1-edit";
    },
  ],
  [
    "incomplete read",
    (f) => {
      f.requests[5].tool_result.result.truncated = true;
    },
  ],
  [
    "invented pre-failure bytes",
    (f) => {
      f.requests[5].tool_result.result.content += "changed";
    },
  ],
  [
    "non-final failed edit",
    (f) => {
      f.requests[15].tool_result.result.effect_state = "unknown";
    },
  ],
  [
    "wrong owning Agent",
    (f) => {
      f.executions[2].agentId = f.agents[1];
    },
  ],
  ["missing execution", (f) => f.executions.pop()],
  [
    "wrong protocol",
    (f) => {
      f.executions[2].protocolVersion = 2;
    },
  ],
])
  test("file checkpoint refuses " + label, () => {
    const prepare = entry("fileStateExpectations");
    const f = fileStateFixture();
    prepare(f.agents, f.requests, f.executions);
    mutate(f);
    assert.throws(() => prepare(f.agents, f.requests, f.executions));
  });

test("missing diagnostics cannot bypass phase, Agent, protocol or original Tool/result bindings", () => {
  const prepare = entry("fileStateExpectations");
  for (const mutate of [
    (f) => {
      f.requests[5].phase = "v2-read";
    },
    (f) => {
      f.executions[2].agentId = f.agents[1];
    },
    (f) => {
      f.executions[2].protocolVersion = 2;
    },
    (f) => {
      f.executions[2].toolCallId = f.executions[1].toolCallId;
      f.requests[5].tool_result.tool_call_id = f.executions[1].toolCallId;
    },
    (f) => {
      f.requests[5].tool_result.tool_call_id = "f".repeat(64);
    },
    (f) => {
      f.requests[5].tool_result.result.content += "changed";
    },
    (f) => {
      f.requests[15].tool_result.result.effect_state = "unknown";
    },
  ]) {
    const f = fileStateFixture();
    diagnosticCases[0][1](f.requests);
    prepare(f.agents, f.requests, f.executions);
    mutate(f);
    assert.throws(() => prepare(f.agents, f.requests, f.executions));
  }
});

test("missing diagnostics cannot bypass host phase, Agent, protocol, Tool uniqueness or content/bytes/hash checks", () => {
  const inspect = entry("inspectFileCheckpoints"),
    agents = runtimes.map((runtime) => runtime.agent_id);
  for (const mutate of [
    (files) => {
      files[0].read.phase = "v2-read";
    },
    (files) => {
      files[0].agent_id = agents[1];
    },
    (files) => {
      files[0].protocol_version = 2;
    },
    (files) => {
      files[0].failed_edit.tool_call_id = files[0].read.tool_call_id;
    },
    (files) => {
      files[0].read.content += "changed";
    },
    (files) => {
      files[0].read.bytes++;
    },
    (files) => {
      files[0].read.sha256 = "f".repeat(64);
    },
  ]) {
    const files = fileCheckpointFixtures();
    diagnosticCases[0][1](
      files.flatMap((file) => [file.read, file.failed_edit]),
    );
    inspect(files, agents);
    mutate(files);
    assert.throws(() => inspect(files, agents));
  }
});

test("host checkpoint rejects the same normalized Tool ID for the read and failed edit", () => {
  const files = fileCheckpointFixtures();
  const inspect = entry("inspectFileCheckpoints");
  inspect(
    files,
    runtimes.map((r) => r.agent_id),
  );
  files[0].failed_edit.tool_call_id = files[0].read.tool_call_id;
  assert.throws(() =>
    inspect(
      files,
      runtimes.map((r) => r.agent_id),
    ),
  );
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "antnest-file-bytes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test("host copies the literal Unicode and trailing-space path from each verified container without another tool call", async (t) => {
  const directory = await fixture(t),
    calls = [];
  const result = await entry("captureFinalFileBytes")({
    directory,
    runtimes,
    files: fileCheckpointFixtures(),
    signal: t.signal,
    docker: async (args, long, { signal }) => {
      assert.equal(signal, t.signal);
      assert.equal(long, false);
      calls.push(args);
      const index = calls.length - 1;
      assert.deepEqual(args, [
        "cp",
        `${runtimes[index].container_id}:/workspace/reports /记录".txt`,
        join(directory, `file-v${index + 1}-after-failed-edit.private.bin`),
      ]);
      await writeFile(args[2], content());
      return "";
    },
  });
  assert.deepEqual(result, fileByteReceiptFixtures(runtimes));
  assert.equal(calls.length, 2);
  for (const receipt of result) {
    const path = join(directory, receipt.final.file);
    assert.deepEqual(await readFile(path), content());
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});
for (const [label, mode] of [
  ["changed bytes", "changed"],
  ["symbolic link", "symlink"],
  ["copy failure", "failure"],
  ["cancelled copy", "cancel"],
])
  test(
    "physical read refuses " + label + " without issuing an acknowledgement",
    async (t) => {
      const directory = await fixture(t),
        controller = new AbortController();
      let calls = 0;
      await assert.rejects(
        entry("captureFinalFileBytes")({
          directory,
          runtimes,
          files: fileCheckpointFixtures(),
          signal: controller.signal,
          docker: async (args) => {
            calls++;
            if (mode === "failure") throw new Error("copy failed");
            if (mode === "symlink") {
              await writeFile(
                join(directory, "foreign.private.bin"),
                content(),
              );
              await symlink(join(directory, "foreign.private.bin"), args[2]);
            } else
              await writeFile(
                args[2],
                mode === "changed" ? Buffer.from("mutated file") : content(),
              );
            if (mode === "cancel")
              controller.abort(new Error("stop file capture"));
            return "";
          },
        }),
      );
      assert.equal(calls, 1);
    },
  );
test("physical read refuses preexisting evidence and unrelated Runtime identity before copying", async (t) => {
  const directory = await fixture(t);
  const files = fileCheckpointFixtures(),
    name = "file-v1-after-failed-edit.private.bin";
  await writeFile(join(directory, name), "prior evidence");
  let calls = 0;
  const docker = async () => {
    calls++;
  };
  await assert.rejects(
    entry("captureFinalFileBytes")({ directory, runtimes, files, docker }),
  );
  assert.equal(await readFile(join(directory, name), "utf8"), "prior evidence");
  await rm(join(directory, name));
  const foreign = structuredClone(runtimes);
  foreign[0].agent_id = "foreign";
  await assert.rejects(
    entry("captureFinalFileBytes")({
      directory,
      runtimes: foreign,
      files,
      docker,
    }),
  );
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(directory), []);
});
test("same-length byte mismatch does not retain the original file buffers in its error", async (t) => {
  const directory = await fixture(t);
  const capture = entry("captureFinalFileBytes");
  const changed = content();
  changed[changed.length - 1] = 65;
  await assert.rejects(
    capture({
      directory,
      runtimes,
      files: fileCheckpointFixtures(),
      docker: async (args) => {
        await writeFile(args[2], changed);
        return "";
      },
    }),
    (error) => {
      assert(
        !Buffer.isBuffer(error.actual),
        "private actual bytes leaked into diagnostic",
      );
      assert(
        !Buffer.isBuffer(error.expected),
        "private earlier read leaked into diagnostic",
      );
      return true;
    },
  );
});
test("file acknowledgement validates exact byte proof and actual Runtime identity", () => {
  const inspect = entry("inspectFinalFileReceipts"),
    files = fileCheckpointFixtures();
  const receipt = fileByteReceiptFixtures(runtimes);
  assert.deepEqual(inspect(receipt, files, runtimes), receipt);
  for (const mutate of [
    (r) => r.pop(),
    (r) => {
      r[0].final.sha256 = "a".repeat(64);
    },
    (r) => {
      r[0].final.bytes++;
    },
    (r) => {
      r[0].final.file = "../foreign";
    },
    (r) => {
      r[0].runtime.container_id = runtimes[1].container_id;
    },
    (r) => {
      r[0].runtime.generation++;
    },
    (r) => {
      r[0].read.model_span_id = "f".repeat(16);
    },
    (r) => {
      r[0].claim = "no-transient-write";
    },
  ]) {
    const changed = structuredClone(receipt);
    mutate(changed);
    assert.throws(() => inspect(changed, files, runtimes));
  }
});
