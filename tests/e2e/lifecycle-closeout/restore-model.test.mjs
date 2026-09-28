import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./restore-model.mjs";

const payload = (phase) => ({
  model: "stage3-model",
  tools: [{ function: { name: "bash" } }, { function: { name: "read" } }],
  messages: [{ role: "user", content: phase }],
});

test("backup fixture requires an actual append before backup and exact read after restore", () => {
  assert.equal(decide(payload("c5-before-backup")).call.name, "bash");
  assert.equal(decide(payload("c5-after-restore")).call.name, "read");
  for (const phase of ["c5-before-backup", "c5-after-restore"]) {
    const input = payload(phase);
    input.messages.push({
      role: "tool",
      content:
        phase === "c5-before-backup"
          ? "backup-written"
          : JSON.stringify({ content: "before-backup\n" }),
    });
    assert.equal(decide(input).text, `${phase} completed`);
    input.messages.push(input.messages.at(-1));
    assert.throws(() => decide(input));
  }
});

test("source recovery fixture keeps an actual Runtime tool call active until released", () => {
  const request = payload("c5-source-held");
  const call = decide(request, true).call;
  assert.equal(call.name, "bash");
  assert.match(call.arguments.command, /\.c5-source-started/u);
  assert.match(call.arguments.command, /\.c5-source-release/u);
  request.messages.push({ role: "tool", content: "source-released" });
  assert.equal(decide(request, true).text, "c5-source-held completed");
  request.messages[1].content = "unexpected";
  assert.throws(() => decide(request, true));
});

test("restore fixture cannot accept replayed writes, missing tools or changed file contents", () => {
  assert.throws(() => decide(payload("unknown")));
  assert.throws(() => decide({ ...payload("c5-before-backup"), tools: [] }));
  for (const content of ["", "before-backup\nbefore-backup\n", "changed"]) {
    const input = payload("c5-after-restore");
    input.messages.push({ role: "tool", content: JSON.stringify({ content }) });
    assert.throws(() => decide(input));
  }
});

test("Stage 4 restore asks the Runtime to read the pinned system Skill", () => {
  const call = decide(payload("c5-after-restore"), true).call;
  assert.equal(call.name, "read");
  assert.deepEqual(call.arguments.path, {
    root: "system_skills",
    path: "code-review/SKILL.md",
  });
  const response = payload("c5-after-restore");
  response.messages.push({
    role: "tool",
    content: JSON.stringify({
      content:
        "---\nname: code-review\n---\nStage 4 immutable preset version 1.",
    }),
  });
  assert.equal(decide(response, true).text, "c5-after-restore completed");
  response.messages[1].content = JSON.stringify({ content: "wrong version" });
  assert.throws(() => decide(response, true));
});

test("second restored Agent reads its own pinned system Skill", () => {
  const request = payload("c5-after-restore-peer");
  const call = decide(request, true).call;
  assert.equal(call.name, "read");
  assert.deepEqual(call.arguments.path, {
    root: "system_skills",
    path: "code-review/SKILL.md",
  });
  request.messages.push({
    role: "tool",
    content: JSON.stringify({
      content:
        "---\nname: code-review\n---\nStage 4 immutable preset version 1.",
    }),
  });
  assert.equal(decide(request, true).text, "c5-after-restore-peer completed");
});

test("post-migration restart Run reads the pinned system Skill again", () => {
  const request = payload("c5-after-migration-restart");
  const call = decide(request, true).call;
  assert.equal(call.name, "read");
  assert.deepEqual(call.arguments.path, {
    root: "system_skills",
    path: "code-review/SKILL.md",
  });
  request.messages.push({
    role: "tool",
    content: JSON.stringify({
      content:
        "---\nname: code-review\n---\nStage 4 immutable preset version 1.",
    }),
  });
  assert.equal(
    decide(request, true).text,
    "c5-after-migration-restart completed",
  );
});

test("post-migration versioned Rebuild reads v2 and rejects the former body", () => {
  const request = payload("c5-after-migration-v2");
  assert.deepEqual(decide(request, true).call.arguments.path, {
    root: "system_skills",
    path: "code-review/SKILL.md",
  });
  request.messages.push({
    role: "tool",
    content: JSON.stringify({
      content:
        "---\nname: code-review\n---\nStage 4 immutable preset version 1.",
    }),
  });
  assert.throws(() => decide(request, true));
  request.messages[1].content = JSON.stringify({
    content: "---\nname: code-review\n---\nStage 4 immutable preset version 2.",
  });
  assert.equal(decide(request, true).text, "c5-after-migration-v2 completed");
});

test("post-migration volume recovery keeps the exact v2 Skill", () => {
  const request = payload("c5-after-migration-volume-loss");
  assert.equal(decide(request, true).call.name, "read");
  request.messages.push({
    role: "tool",
    content: JSON.stringify({
      content:
        "---\nname: code-review\n---\nStage 4 immutable preset version 2.",
    }),
  });
  assert.equal(
    decide(request, true).text,
    "c5-after-migration-volume-loss completed",
  );
  request.messages[1].content = JSON.stringify({
    content: "Stage 4 immutable preset version 1.",
  });
  assert.throws(() => decide(request, true));
});

test("unaffected restored Agent can still read its Skill after peer volume loss", () => {
  const request = payload("c5-after-peer-volume-loss");
  assert.deepEqual(decide(request, true).call.arguments.path, {
    root: "system_skills",
    path: "code-review/SKILL.md",
  });
  request.messages.push({
    role: "tool",
    content: JSON.stringify({
      content:
        "---\nname: code-review\n---\nStage 4 immutable preset version 1.",
    }),
  });
  assert.equal(
    decide(request, true).text,
    "c5-after-peer-volume-loss completed",
  );
});
