import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { routeParts } from "../src/http/command-routes.ts";
import { learningStatusSchema } from "../src/protocol/learning-status.ts";

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../../../contracts/common/id-vectors.json", import.meta.url),
    "utf8",
  ),
) as Record<string, { accept: string[]; reject: string[] }>;

test("workspace agent route keeps opaque Agent references verbatim", () => {
  for (const value of vectors.agentId.accept) {
    const parts = routeParts(
      `/api/app/workspace/v1/agents/${encodeURIComponent(value)}/sessions/session+opaque/prompts`,
    );
    assert.notStrictEqual(parts, null, `route must accept ${JSON.stringify(value)}`);
    assert.strictEqual(parts?.[0], value);
    assert.strictEqual(parts?.[1], "session+opaque");
  }
  for (const value of vectors.agentId.reject) {
    assert.strictEqual(
      routeParts(
        `/api/app/workspace/v1/agents/${encodeURIComponent(value)}/sessions/session+opaque/prompts`,
      ),
      null,
      `route must reject ${JSON.stringify(value)}`,
    );
  }
});

test("learning status protocol matches the shared agent grammar", () => {
  for (const value of vectors.agentId.accept) {
    assert.strictEqual(
      learningStatusSchema.safeParse({ agentId: value, blocked: null }).success,
      true,
      `must accept ${JSON.stringify(value)}`,
    );
  }
  for (const value of vectors.agentId.reject) {
    assert.strictEqual(
      learningStatusSchema.safeParse({ agentId: value, blocked: null }).success,
      false,
      `must reject ${JSON.stringify(value)}`,
    );
  }
});
