import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { durablePath } from "./storage.mjs";

function sources(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : entry.isFile() && entry.name.endsWith(".go")
        ? [path]
        : [];
  });
}

export function writeGoOverlay({
  root,
  service,
  output,
  profile = "integration",
}) {
  output = durablePath(output);
  root = realpathSync(root);
  assert(/^[a-z][a-z0-9-]*$/.test(service), "invalid service");
  assert(
    ["integration", "e2e", "all"].includes(profile),
    "invalid Go test profile",
  );
  const Replace = {};
  for (const scope of profile === "all" ? ["integration", "e2e"] : [profile]) {
    const base = resolve(root, "tests", scope, "go", service);
    for (const source of sources(base).sort()) {
      const original = resolve(
        root,
        "services",
        service,
        relative(base, source),
      );
      assert(
        !existsSync(original),
        "overlay would replace existing service source",
      );
      assert(!Replace[original], "duplicate integration source");
      Replace[original] = source;
    }
  }
  assert(
    Object.keys(Replace).length > 0,
    "no root Go test sources for service",
  );
  // Go's compiler sees virtual files, but vet still chdirs to the package.
  // Empty package directories contain no duplicated test implementation.
  for (const original of Object.keys(Replace))
    mkdirSync(dirname(original), { recursive: true });
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const path = resolve(output, `go-overlay-${service}-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ Replace }, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  return path;
}
