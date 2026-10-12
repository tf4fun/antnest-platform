import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { durablePath, writeEvidenceFile } from "../../support/storage.mjs";
import { collectWorkspaceChatTrace } from "../workspace-closeout/chat-trace.mjs";
import { outageChatExpectation } from "./resolve-cache-outage-collect.mjs";

// Recheck an immutable, previously collected Docker archive with a new owning
// inspector. This never starts Docker or queries Jaeger and is not a new E2E run.
export async function replayOutageCancellation(input, output) {
  input = durablePath(input);
  output = durablePath(output);
  assert(!existsSync(output), "replay output must be unused");
  const sources = new Map();
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const read = (name) => {
    const file = join(input, name);
    assert(lstatSync(file).isFile(), "replay input must be a regular file");
    const raw = readFileSync(file, "utf8");
    const digest = hash(raw);
    if (sources.has(name))
      assert.equal(
        sources.get(name),
        digest,
        "retained archive changed during replay",
      );
    sources.set(name, digest);
    return JSON.parse(raw);
  };
  const original = read("outage-trace-archive.json");
  assert.equal(
    original.status,
    "raw_closures_archived_owning_admission_pending",
  );
  const archived = new Set(original.archived_trace_ids);
  const expected = outageChatExpectation(read("outage-window.private.json"));
  const cancellation = await collectWorkspaceChatTrace(
    "http://retained.invalid",
    expected,
    [],
    {
      directory: join(output, "traces"),
      attempts: 3,
      wait: async () => {},
      request: async (url) => {
        const request = new URL(url);
        assert.equal(request.origin, "http://retained.invalid");
        assert.match(request.pathname, /^\/api\/traces\/[a-f0-9]{32}$/u);
        const id = request.pathname.split("/").at(-1);
        assert(
          archived.has(id),
          "replay source absent from original archive inventory",
        );
        return Response.json({ data: [read(`outage-traces/${id}.json`)] });
      },
    },
  );
  for (const [name, digest] of sources)
    assert.equal(
      hash(readFileSync(join(input, name))),
      digest,
      "retained archive changed during replay",
    );
  const result = {
    evidence_kind: "offline_replay_not_new_docker_execution",
    source_archive: input,
    cancellation,
    source_files: [...sources]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, sha256]) => ({ path, sha256 })),
    pending: [
      "other-trace-owning-gates",
      "authority-budgets",
      "cold-and-expired-http",
      "recovery-revocations",
      "final-ci",
    ],
  };
  writeEvidenceFile(
    output,
    "outage-cancellation-replay.json",
    JSON.stringify(result, null, 2),
  );
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  assert.equal(
    process.argv.length,
    4,
    "usage: resolve-cache-outage-replay.mjs INPUT OUTPUT",
  );
  const result = await replayOutageCancellation(
    process.argv[2],
    process.argv[3],
  );
  console.log(JSON.stringify(result));
  process.exitCode = result.cancellation.strict_trace === "failed" ? 2 : 0;
}
