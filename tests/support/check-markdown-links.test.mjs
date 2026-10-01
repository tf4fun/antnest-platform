import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  brokenMarkdownLinks,
  relativeLinkTargets,
} from "./check-markdown-links.mjs";

test("relative targets skip URLs, anchors, and fenced code", () => {
  const markdown = [
    "[a](docs/a.md#section) [b](https://example.com) [c](#local)",
    "[d](mailto:security@example.com) [e](<docs/with space.md>)",
    "```md",
    "[ignored](missing.md)",
    "```",
    '[f](../f.md "title")',
  ].join("\n");
  assert.deepEqual(relativeLinkTargets(markdown), [
    "docs/a.md",
    "docs/with space.md",
    "../f.md",
  ]);
});

test("broken links resolve against the linking file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "antnest-links-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "present.md"), "# Present\n");
  writeFileSync(
    join(root, "docs", "index.md"),
    "[ok](present.md) [up](../README.md) [missing](gone.md)\n",
  );
  assert.deepEqual(brokenMarkdownLinks(root, ["docs/index.md"]), [
    { file: "docs/index.md", target: "../README.md" },
    { file: "docs/index.md", target: "gone.md" },
  ]);
});
