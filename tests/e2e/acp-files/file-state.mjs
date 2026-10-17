import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { durablePath, shellStoragePreflight } from "../../support/storage.mjs";
import { cases, caseFor } from "./model.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value, keys) =>
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
const reference = (row) => ({
  phase: row.phase,
  trace_id: row.trace_id,
  model_span_id: row.model_span_id,
  tool_call_id: row.tool_result.tool_call_id,
});
const filename = (version) => `file-v${version}-after-failed-edit.private.bin`;

export function inspectFileCheckpoints(files, agents) {
  assert(
    Array.isArray(agents) && agents.length === 2 && new Set(agents).size === 2,
  );
  assert(agents.every((id) => typeof id === "string" && id.length > 0));
  assert(Array.isArray(files) && files.length === 2);
  for (const [index, file] of files.entries()) {
    const version = index + 1;
    exactKeys(file, [
      "protocol_version",
      "agent_id",
      "path",
      "read",
      "failed_edit",
    ]);
    assert.equal(file.protocol_version, version);
    assert.equal(file.agent_id, agents[index]);
    const item = caseFor(`v${version}-read`);
    assert.equal(file.path, item.path);
    assert.equal(caseFor(`v${version}-failed-edit`).path, file.path);
    for (const [name, phase] of [
      ["read", `v${version}-read`],
      ["failed_edit", `v${version}-failed-edit`],
    ]) {
      const row = file[name];
      exactKeys(row, [
        "phase",
        "trace_id",
        "model_span_id",
        "tool_call_id",
        ...(name === "read" ? ["content", "bytes", "sha256"] : []),
      ]);
      assert.equal(row.phase, phase);
      assert.match(row.tool_call_id ?? "", /^[a-f0-9]{64}$/u);
      assert.match(row.trace_id ?? "", /^[a-f0-9]{32}$/u);
      assert.match(row.model_span_id ?? "", /^[a-f0-9]{16}$/u);
    }
    assert.notEqual(file.read.trace_id, file.failed_edit.trace_id);
    assert.equal(file.read.content, item.result.content);
    const bytes = Buffer.from(file.read.content);
    assert.equal(file.read.bytes, bytes.length);
    assert.equal(file.read.sha256, sha256(bytes));
  }
  assert.equal(
    new Set(
      files.flatMap((file) => [
        file.read.tool_call_id,
        file.failed_edit.tool_call_id,
      ]),
    ).size,
    4,
    "reused file checkpoint Tool ID",
  );
  assert.equal(
    new Set(
      files.flatMap((file) => [file.read.trace_id, file.failed_edit.trace_id]),
    ).size,
    4,
  );
  return files;
}

// The original parsed Tool results are the source of the before observation.
// The full model inventory is archived separately by the client.
export function fileStateExpectations(agents, requests, executions) {
  const phases = [1, 2].flatMap((version) =>
    cases.map((item) => `v${version}-${item.id}`),
  );
  assert.deepEqual(
    executions.map((row) => row.phase),
    phases,
  );
  assert.deepEqual(
    requests.map((row) => [row.phase, row.stage]),
    phases.flatMap((phase) => [
      [phase, "tool"],
      [phase, "final"],
    ]),
  );
  assert.equal(new Set(requests.map((row) => row.model_span_id)).size, 32);
  assert.equal(new Set(requests.map((row) => row.trace_id)).size, 16);
  assert.equal(
    new Set(executions.map((row) => row.toolCallId)).size,
    16,
    "reused live file Tool ID",
  );
  for (const [index, phase] of phases.entries()) {
    const version = Number(phase[1]),
      item = caseFor(phase);
    const [first, final] = requests.slice(index * 2, index * 2 + 2);
    assert.equal(executions[index].agentId, agents[version - 1]);
    assert.equal(executions[index].protocolVersion, version);
    assert.match(executions[index].toolCallId ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(first.trace_id, final.trace_id);
    assert.equal(first.tool_result, undefined);
    for (const row of [first, final]) {
      assert.match(row.trace_id ?? "", /^[a-f0-9]{32}$/u);
      assert.match(row.model_span_id ?? "", /^[a-f0-9]{16}$/u);
    }
    assert.deepEqual(final.tool_result, {
      tool_call_id: executions[index].toolCallId,
      tool: item.tool,
      result: item.result,
    });
  }
  const files = agents.map((agent_id, index) => {
    const version = index + 1;
    const read = requests.find(
      (row) => row.phase === `v${version}-read` && row.stage === "final",
    );
    const failed = requests.find(
      (row) => row.phase === `v${version}-failed-edit` && row.stage === "final",
    );
    const content = read.tool_result.result.content;
    const bytes = Buffer.from(content);
    return {
      protocol_version: version,
      agent_id,
      path: caseFor(read.phase).path,
      read: {
        ...reference(read),
        content,
        bytes: bytes.length,
        sha256: sha256(bytes),
      },
      failed_edit: reference(failed),
    };
  });
  return inspectFileCheckpoints(files, agents);
}

export function inspectFinalFileReceipts(receipts, files, runtimes) {
  assert(Array.isArray(runtimes) && runtimes.length === 2);
  inspectFileCheckpoints(
    files,
    runtimes.map((row) => row.agent_id),
  );
  assert(Array.isArray(receipts) && receipts.length === 2);
  for (const [index, receipt] of receipts.entries()) {
    const file = files[index];
    assert.deepEqual(receipt, {
      ...file,
      runtime: runtimes[index],
      final: {
        file: filename(file.protocol_version),
        bytes: file.read.bytes,
        sha256: file.read.sha256,
      },
      claim: "final-bytes-equal-last-complete-read",
    });
  }
  return receipts;
}

export async function captureFinalFileBytes({
  directory,
  runtimes,
  files,
  docker,
  signal,
}) {
  signal?.throwIfAborted();
  assert(Array.isArray(runtimes) && runtimes.length === 2);
  inspectFileCheckpoints(
    files,
    runtimes.map((row) => row.agent_id),
  );
  assert.equal(new Set(runtimes.map((row) => row.container_id)).size, 2);
  for (const runtime of runtimes)
    assert.match(runtime.container_id ?? "", /^[a-f0-9]{64}$/u);
  directory = durablePath(directory);
  shellStoragePreflight(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const receipts = [];
  for (const [index, file] of files.entries()) {
    signal?.throwIfAborted();
    const name = filename(file.protocol_version),
      path = join(directory, name);
    await assert.rejects(
      lstat(path),
      (error) => error.code === "ENOENT",
      "refuse to overwrite prior physical evidence",
    );
    // A literal argv preserves Unicode, quotes and the space in the directory.
    // Docker cp without -L must produce a regular file, never a followed link.
    await docker(
      ["cp", `${runtimes[index].container_id}:${file.path}`, path],
      false,
      { signal },
    );
    signal?.throwIfAborted();
    const observed = await lstat(path);
    assert(
      observed.isFile() && !observed.isSymbolicLink(),
      "physical file evidence must be a regular file",
    );
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actual = await handle.stat();
      assert(
        actual.isFile() &&
          actual.dev === observed.dev &&
          actual.ino === observed.ino,
      );
      await handle.chmod(0o600);
      assert.equal(
        actual.size,
        file.read.bytes,
        "final file byte length differs from the actual earlier read",
      );
      const bytes = await handle.readFile();
      signal?.throwIfAborted();
      assert(
        bytes.equals(Buffer.from(file.read.content)),
        "final bytes differ from the actual earlier complete read",
      );
      receipts.push({
        ...file,
        runtime: runtimes[index],
        final: { file: name, bytes: bytes.length, sha256: sha256(bytes) },
        claim: "final-bytes-equal-last-complete-read",
      });
    } finally {
      await handle.close();
    }
  }
  return inspectFinalFileReceipts(receipts, files, runtimes);
}
