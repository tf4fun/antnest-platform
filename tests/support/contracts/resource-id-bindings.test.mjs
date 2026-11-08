import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { validateGolden } from "./golden.mjs";

const contractsRoot = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const CANONICAL = "https://schemas.antnest.dev/";

function* idsV2Schemas(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* idsV2Schemas(path);
    else if (entry.name.endsWith(".ids-v2.schema.json")) yield path;
  }
}

function* walk(node, pointer = "") {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) yield* walk(node[i], `${pointer}/${i}`);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) yield* walk(value, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
  if (typeof node.$ref === "string") yield [pointer, node.$ref];
}

test("current ID revisions reference current resource schemas", () => {
  const failures = [];
  for (const file of idsV2Schemas(contractsRoot)) {
    const source = JSON.parse(readFileSync(file, "utf8"));
    const fileURL = pathToFileURL(file);
    for (const [pointer, ref] of walk(source)) {
      const base = ref.split("#", 1)[0];
      if (base === "") continue;
      let targetPath;
      if (base.startsWith(CANONICAL)) {
        targetPath = join(contractsRoot, base.slice(CANONICAL.length));
      } else {
        if (base.startsWith("http://") || base.startsWith("https://")) continue;
        targetPath = fileURLToPath(new URL(base, fileURL));
      }
      const rootRelative = relative(contractsRoot, targetPath);
      if (rootRelative.startsWith("..")) continue;
      if (!rootRelative.endsWith(".schema.json") || rootRelative.endsWith(".ids-v2.schema.json")) continue;
      const newer = targetPath.replace(/\.schema\.json$/, ".ids-v2.schema.json");
      if (existsSync(newer)) {
        failures.push(`${relative(contractsRoot, file)}${pointer || "#"} -> ${ref}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("published shared reference nodes obey all vectors", async () => {
  const vectors = JSON.parse(readFileSync(join(contractsRoot, "common/id-vectors.json"), "utf8"));
  const kindOf = { organizationId: "organizationId", agentId: "agentId", userId: "userId" };
  const nodes = [];
  for (const file of idsV2Schemas(contractsRoot)) {
    const source = JSON.parse(readFileSync(file, "utf8"));
    for (const [pointer, ref] of walk(source)) {
      const match = /common\/ids\.schema\.json#\/\$defs\/(organizationId|agentId|userId)$/.exec(ref);
      if (match) nodes.push({ pointer, kind: kindOf[match[1]], file });
    }
  }
  const seen = new Set(nodes.map((node) => node.kind));
  assert.ok(seen.has("organizationId") && seen.has("userId") && seen.has("agentId"),
    `missing kinds: ${[...seen]}`);
  for (const { pointer, kind, file } of nodes) {
    const ref = `${relative(contractsRoot, file)}#${pointer}`;
    for (const value of vectors[kind].accept) {
      assert.equal(await validateGolden(ref, value), true, `${ref} must accept ${JSON.stringify(value)}`);
    }
    for (const value of vectors[kind].reject) {
      await assert.rejects(validateGolden(ref, value), undefined, `${ref} must reject ${JSON.stringify(value)}`);
    }
    for (const value of [null, 42, {}]) {
      await assert.rejects(validateGolden(ref, value), undefined, `${ref} must reject ${JSON.stringify(value)}`);
    }
  }
});
