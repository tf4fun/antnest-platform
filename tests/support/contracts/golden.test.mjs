import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadGolden, readManifest, validateGolden } from "./golden.mjs";

const contractsDir = fileURLToPath(
  new URL("../../../contracts/", import.meta.url),
);
const servicesDir = fileURLToPath(
  new URL("../../../services/", import.meta.url),
);

const knownServices = new Set([
  ...readdirSync(servicesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
  "antnest-runtime",
]);

const FILE_SHAPE = /^[^/\\]+\/examples\/[^/\\.]+\.[^/\\]+\.json$/;

function exampleFiles() {
  const files = [];
  const visit = (dir, prefix) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory())
        visit(join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".json"))
        files.push(`${prefix}${entry.name}`);
    }
  };
  const areas = readdirSync(contractsDir, { withFileTypes: true });
  areas.sort((a, b) => a.name.localeCompare(b.name));
  for (const area of areas) {
    if (!area.isDirectory()) continue;
    const examples = join(contractsDir, area.name, "examples");
    if (existsSync(examples)) visit(examples, `${area.name}/examples/`);
  }
  return files;
}

test("every manifest entry is exact and names known services on a safe path", () => {
  const seen = new Set();
  for (const entry of readManifest()) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["consumers", "file", "producer", "schema"],
      `manifest entry shape: ${JSON.stringify(entry)}`,
    );
    assert.match(entry.file, FILE_SHAPE);
    assert.ok(!entry.file.includes(".."), `unsafe manifest file ${entry.file}`);
    assert.ok(!seen.has(entry.file), `duplicate manifest file ${entry.file}`);
    seen.add(entry.file);
    assert.equal(typeof entry.schema, "string");
    assert.notEqual(entry.schema, "");
    assert.ok(
      typeof entry.producer === "string" && knownServices.has(entry.producer),
      `unknown manifest producer ${entry.producer} for ${entry.file}`,
    );
    assert.ok(
      Array.isArray(entry.consumers) && entry.consumers.length > 0,
      `manifest consumers for ${entry.file}`,
    );
    for (const consumer of entry.consumers)
      assert.ok(
        typeof consumer === "string" && knownServices.has(consumer),
        `unknown manifest consumer ${consumer} for ${entry.file}`,
      );
  }
});

test("manifest covers every contracts example exactly once", () => {
  const manifest = readManifest();
  const declared = new Set(manifest.map((entry) => entry.file));
  const recorded = new Set(exampleFiles());
  for (const file of declared)
    assert.ok(recorded.has(file), `manifest golden missing on disk: ${file}`);
  for (const file of recorded)
    assert.ok(
      declared.has(file),
      `contracts example missing manifest entry: ${file}`,
    );
  assert.equal(declared.size, recorded.size);
});

test("every golden document validates against its manifest schema", async () => {
  for (const entry of readManifest()) {
    const [area, , filename] = entry.file.split("/");
    await validateGolden(entry.schema, loadGolden(area, filename));
  }
});
