import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { verifyIdentityEvidence } from "../e2e/identity-closeout/trace.mjs";
import {
  collectDeniedMessage,
  saveSessionTrace,
} from "../e2e/identity-closeout/session-trace.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "antnest-evidence-storage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const id = "a".repeat(32);

for (const kind of [
  "cache-directory",
  "dangling-directory",
  "cache-leaf",
  "dangling-leaf",
  "directory-leaf",
])
  test(`Identity rejects ${kind} before fetching any Trace`, async (t) => {
    const root = fixture(t),
      output = join(root, "evidence");
    mkdirSync(output);
    mkdirSync(join(root, ".cache"));
    let directory = output;
    if (kind === "cache-directory") directory = join(root, ".cache/output");
    if (kind === "dangling-directory") {
      directory = join(root, "alias");
      symlinkSync(join(root, ".cache/missing"), directory);
    }
    if (kind === "cache-leaf")
      symlinkSync(join(root, ".cache"), join(output, id + ".json"));
    if (kind === "dangling-leaf")
      symlinkSync(join(root, ".cache/missing"), join(output, id + ".json"));
    if (kind === "directory-leaf") mkdirSync(join(output, id + ".json"));
    let requests = 0;
    await assert.rejects(
      verifyIdentityEvidence("http://fixture", [{ traceID: id }], [], {
        directory,
        attempts: 1,
        request: async () => {
          requests++;
          throw new Error("fixture external call");
        },
      }),
    );
    assert.equal(requests, 0);
  });

test("Identity validates every known leaf before collecting the first Trace", async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "b".repeat(32) + ".json"));
  let requests = 0;
  await assert.rejects(
    verifyIdentityEvidence(
      "http://fixture",
      [{ traceID: id }, { traceID: "b".repeat(32) }],
      [],
      {
        directory: root,
        attempts: 1,
        request: async () => {
          requests++;
          throw new Error("fixture external call");
        },
      },
    ),
  );
  assert.equal(requests, 0);
});

test("denied Session collection rejects cached directory before search", async (t) => {
  const root = fixture(t);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("FETCH_ATTEMPTED");
  });
  const previous = process.env.ANTNEST_IDENTITY_EVIDENCE_DIR;
  process.env.ANTNEST_IDENTITY_EVIDENCE_DIR = join(root, ".cache/evidence");
  t.after(() => {
    if (previous === undefined)
      delete process.env.ANTNEST_IDENTITY_EVIDENCE_DIR;
    else process.env.ANTNEST_IDENTITY_EVIDENCE_DIR = previous;
  });
  await assert.rejects(
    collectDeniedMessage("http://fixture", { method: "session/prompt" }, []),
  );
  assert.equal(fetch.mock.callCount(), 0);
});

test("Session raw evidence preserves repeated snapshots and rejects a replaced cache leaf", (t) => {
  const root = fixture(t),
    previous = process.env.ANTNEST_IDENTITY_EVIDENCE_DIR;
  process.env.ANTNEST_IDENTITY_EVIDENCE_DIR = root;
  t.after(() => {
    if (previous === undefined)
      delete process.env.ANTNEST_IDENTITY_EVIDENCE_DIR;
    else process.env.ANTNEST_IDENTITY_EVIDENCE_DIR = previous;
  });
  saveSessionTrace({ traceID: id, spans: [] });
  saveSessionTrace({ traceID: id, spans: [{ spanID: "updated" }] });
  assert.equal(
    JSON.parse(readFileSync(join(root, id + ".json"))).spans.length,
    1,
  );
  rmSync(join(root, id + ".json"));
  mkdirSync(join(root, ".cache"));
  symlinkSync(join(root, ".cache/raw.json"), join(root, id + ".json"));
  assert.throws(() => saveSessionTrace({ traceID: id, spans: [] }));
  assert(!existsSync(join(root, ".cache/raw.json")));
});
